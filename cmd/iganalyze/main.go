// iganalyze — parallel Qwen multimodal analysis of scraped IG media.
//
// Uses Alibaba Token Plan OpenAI-compatible chat completions:
//
//	images → content type image_url (data URL)
//	videos → content type video_url (Qwen native video understanding)
//
// Usage:
//
//	go run ./cmd/iganalyze \
//	  -profile data/profiles/<user>-profile.json \
//	  -media data/media/<user> \
//	  -out data/analysis/<user> \
//	  -workers 2 -per-shortcode
//	  -skip-reels
//	  -all-frames   # every file per shortcode (overrides -per-shortcode)
//
// Auth: QWEN_API_KEY or DASHSCOPE_API_KEY (loaded from env / .env).
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gts/patronum/internal/home"
	"github.com/gts/patronum/internal/videoprobe"
)

const (
	defaultBaseURL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
	defaultModel   = "qwen3.8-max"
	// Alibaba: Base64-encoded video payload must stay under 10MB.
	maxVideoEncoded          = 9 * 1024 * 1024
	maxImageBytes            = 10 * 1024 * 1024
	sampledFramesMethod      = "sampled-video-frames"
	sampledFramesVersion     = 1
	sampledFramesLimitations = "Only ordered still frames were observed; motion between frames, cuts, pacing, and audio cannot be verified."
	analysisSystem           = `You are a senior social-content strategist analyzing Instagram media for a client brand kit.
Respond with STRICT JSON only (no markdown fences). Schema:
{
  "summary": "1-2 sentence visual summary",
  "subjects": ["main subjects"],
  "setting": "place/context if visible",
  "palette": ["#hex or color names"],
  "mood": ["mood words"],
  "composition": "framing, camera, layout notes",
  "text_overlays": ["on-image text if any"],
  "brand_cues": ["logo, merch, venue, props that signal brand"],
  "content_type": "photo|carousel_frame|reel_still|video|graphic|other",
  "hooks": ["what makes this scroll-stopping"],
  "style_tags": ["visual style tags for matching future content"],
  "content_ideas": ["2-4 content ideas in THIS visual style for the same brand"],
  "audio_or_motion": "for video: motion, pacing, on-screen action; null for stills",
  "confidence": 0.0
}
Be concrete. Do not invent brand names not evidenced. Prefer observations over marketing fluff.`
)

type profileJSON struct {
	Username string `json:"username"`
	FullName string `json:"fullName"`
	BioRaw   string `json:"bioRaw"`
	Location string `json:"location"`
	Posts    []item `json:"posts"`
	Reels    []item `json:"reels"`
}

type item struct {
	MediaOwnershipVersion int            `json:"mediaOwnershipVersion"`
	Shortcode             string         `json:"shortcode"`
	Type                  string         `json:"type"`
	Caption               string         `json:"caption"`
	Permalink             string         `json:"permalink"`
	MediaURLs             []string       `json:"mediaUrls"`
	ThumbnailURL          *string        `json:"thumbnailUrl"`
	CarouselMedia         []carouselItem `json:"carouselMedia"`
	IsVideo               *bool          `json:"isVideo"`
}

type carouselItem struct {
	MediaURL     *string `json:"mediaUrl"`
	ThumbnailURL *string `json:"thumbnailUrl"`
	IsVideo      *bool   `json:"isVideo"`
}

type manifestFile struct {
	ByURL   map[string]string `json:"byUrl"`
	Results []struct {
		URL      string `json:"url"`
		Local    string `json:"localPath"`
		Status   string `json:"status"`
		Filename string `json:"filename"`
	} `json:"results"`
}

type uniqueManifest struct {
	Files  []uniqueMediaFile `json:"files"`
	Stills []uniqueMediaFile `json:"stills"`
}

type uniqueMediaFile struct {
	Shortcode string `json:"shortcode"`
	Dest      string `json:"dest"`
}

type job struct {
	ID        string // stable per-item cache/output ID
	Kind      string // post|reel
	LocalPath string
	MediaType string // image|video
	Caption   string
	Permalink string
	Shortcode string
	SourceSHA string
}

type analysisResult struct {
	ID              string          `json:"id"`
	Shortcode       string          `json:"shortcode,omitempty"`
	Kind            string          `json:"kind"`
	LocalPath       string          `json:"localPath"`
	MediaType       string          `json:"mediaType"`
	Caption         string          `json:"caption,omitempty"`
	Permalink       string          `json:"permalink,omitempty"`
	Status          string          `json:"status"` // ok|skipped|error
	Error           string          `json:"error,omitempty"`
	Model           string          `json:"model,omitempty"`
	AnalyzedAt      string          `json:"analyzedAt,omitempty"`
	Analysis        json.RawMessage `json:"analysis,omitempty"`
	RawText         string          `json:"rawText,omitempty"`
	InputHash       string          `json:"inputHash,omitempty"`
	ProviderFailure string          `json:"providerFailure,omitempty"`
	ProviderStatus  int             `json:"providerStatus,omitempty"`
	AnalysisMethod  string          `json:"analysisMethod,omitempty"`
	MethodVersion   int             `json:"analysisMethodVersion,omitempty"`
	FrameCount      int             `json:"frameCount,omitempty"`
	Limitations     string          `json:"limitations,omitempty"`
}

type providerFailureError struct {
	Kind   string
	Status int
}

func (e *providerFailureError) Error() string {
	if e.Kind == "auth" {
		return fmt.Sprintf("LLM authentication rejected (HTTP %d)", e.Status)
	}
	return fmt.Sprintf("LLM quota exhausted (HTTP %d)", e.Status)
}

func main() {
	loadDotEnv(".env")
	profilePath := flag.String("profile", "", "path to scrape-profile JSON")
	mediaDir := flag.String("media", "", "media directory (default data/media/<user>)")
	outDir := flag.String("out", "", "analysis output dir (default data/analysis/<user>)")
	workers := flag.Int("workers", 2, "parallel Qwen workers")
	maxJobs := flag.Int("max", 0, "cap jobs (0=all)")
	perShortcode := flag.Bool("per-shortcode", true, "one owned media asset per shortcode (preferred frame); pass -per-shortcode=false or -all-frames for every owned asset")
	allFrames := flag.Bool("all-frames", false, "analyze every owned media asset per shortcode (overrides -per-shortcode)")
	stills := flag.Bool("stills", true, "also analyze unique/native stills (image_url) alongside video")
	fresh := flag.Bool("fresh", false, "re-analyze even if analysis exists")
	skipReels := flag.Bool("skip-reels", false, "skip reels and standalone videos; image + carousel posts only")
	model := flag.String("model", envOr("QWEN_MODEL", defaultModel), "Qwen model (qwen3.8-max native video)")
	baseURL := flag.String("base-url", envOr("QWEN_BASE_URL", defaultBaseURL), "OpenAI-compatible API base URL")
	flag.Parse()

	if *profilePath == "" {
		fmt.Fprintln(os.Stderr, "error: -profile required")
		flag.Usage()
		os.Exit(2)
	}
	if *workers < 1 {
		*workers = 1
	}

	prof, err := loadProfile(*profilePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: profile: %v\n", err)
		os.Exit(1)
	}
	user := prof.Username
	if user == "" {
		user = "unknown"
	}
	if *mediaDir == "" {
		*mediaDir = home.Path("data", "media", user)
	}
	if *outDir == "" {
		*outDir = home.Path("data", "analysis", user)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "error: mkdir: %v\n", err)
		os.Exit(1)
	}

	apiKey, err := resolveAPIKey()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: llm: %v\n", err)
		b, _ := json.Marshal(map[string]any{"ok": false, "error": "llm", "reason": err.Error()})
		fmt.Println(string(b))
		os.Exit(4)
	}

	if *skipReels {
		fmt.Println("iganalyze: -skip-reels — image + carousel posts only")
	}
	perSC := resolvePerShortcode(*perShortcode, *allFrames)
	if *allFrames {
		fmt.Println("iganalyze: -all-frames — every media file per shortcode")
	}
	jobs, err := collectJobs(prof, *mediaDir, perSC, *stills, *skipReels)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: collect jobs: %v\n", err)
		os.Exit(1)
	}
	if *maxJobs > 0 && len(jobs) > *maxJobs {
		jobs = jobs[:*maxJobs]
	}

	// Resume: skip IDs that already have ok analysis
	priorOK := map[string]analysisResult{}
	if !*fresh {
		priorOK = loadPriorOK(*outDir)
	}
	var pending []job
	var resumed []analysisResult
	for _, j := range jobs {
		if r, ok := priorOK[j.ID]; ok && !*fresh && cacheMatches(r, j, *model, *baseURL) {
			resumed = append(resumed, r)
			continue
		}
		pending = append(pending, j)
	}

	fmt.Printf("iganalyze: user=%s model=%s jobs=%d pending=%d resume-skip=%d workers=%d\n",
		user, *model, len(jobs), len(pending), len(resumed), *workers)

	client := &http.Client{Timeout: 10 * time.Minute}
	results := make([]analysisResult, 0, len(jobs))
	results = append(results, resumed...)

	if len(pending) > 0 {
		freshResults, err := runPool(client, apiKey, *baseURL, *model, *outDir, pending, *workers)
		if err != nil {
			var providerErr *providerFailureError
			if errors.As(err, &providerErr) {
				fmt.Fprintf(os.Stderr, "error: %v; stopped remaining analysis jobs\n", providerErr)
				b, _ := json.Marshal(map[string]any{
					"ok": false, "error": "llm", "failureKind": providerErr.Kind,
					"reason": providerErr.Error(), "retryable": false,
				})
				fmt.Println(string(b))
				os.Exit(4)
			}
			fmt.Fprintf(os.Stderr, "error: checkpoint analysis: %v\n", err)
			os.Exit(1)
		}
		results = append(results, freshResults...)
	}

	// Write aggregate after each new result has its own checkpoint.
	var okN, skipN, failN int
	for _, r := range results {
		switch r.Status {
		case "ok":
			okN++
		case "skipped":
			skipN++
		default:
			failN++
		}
	}

	aggPath := filepath.Join(*outDir, "analysis.json")
	agg := map[string]any{
		"username":   user,
		"fullName":   prof.FullName,
		"bioRaw":     prof.BioRaw,
		"location":   prof.Location,
		"model":      *model,
		"analyzedAt": time.Now().UTC().Format(time.RFC3339),
		"total":      len(results),
		"ok":         okN,
		"skipped":    skipN,
		"failed":     failN,
		"items":      results,
	}
	if err := writeJSON(aggPath, agg); err != nil {
		fmt.Fprintf(os.Stderr, "error: write aggregate: %v\n", err)
		os.Exit(1)
	}

	// Compact style digest for KB seeding (force valid UTF-8)
	digestPath := filepath.Join(*outDir, "style-digest.md")
	digest := strings.ToValidUTF8(buildStyleDigest(user, prof, results), "�")
	_ = os.WriteFile(digestPath, []byte(digest), 0o644)

	fmt.Printf("done: ok=%d skipped=%d failed=%d → %s\n", okN, skipN, failN, aggPath)
	tail := map[string]any{
		"ok": true, "dir": *outDir, "analyzed": okN, "failed": failN, "skipped": skipN,
		"analysisPath": aggPath, "digestPath": digestPath,
	}
	if failN > 0 && okN == 0 {
		tail["ok"] = false
		tail["error"] = "llm"
		b, _ := json.Marshal(tail)
		fmt.Println(string(b))
		os.Exit(4)
	}
	b, _ := json.Marshal(tail)
	fmt.Println(string(b))
}

func resolveAPIKey() (string, error) {
	for _, key := range []string{"QWEN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_API_KEY"} {
		if k := strings.TrimSpace(os.Getenv(key)); k != "" {
			return k, nil
		}
	}
	return "", fmt.Errorf("set QWEN_API_KEY or DASHSCOPE_API_KEY")
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func loadDotEnv(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(line[len("export "):])
		}
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.TrimSpace(line[i+1:])
		if len(v) >= 2 {
			if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
				v = v[1 : len(v)-1]
			}
		}
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
}

func chatCompletionsURL(base string) string {
	b := strings.TrimRight(strings.TrimSpace(base), "/")
	if strings.HasSuffix(b, "/chat/completions") {
		return b
	}
	return b + "/chat/completions"
}

func loadProfile(path string) (*profileJSON, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var p profileJSON
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// isReelOrVideoPost reports a reel or standalone feed video (not image/carousel).
func isReelOrVideoPost(it item) bool {
	t := strings.ToLower(strings.TrimSpace(it.Type))
	if t == "carousel" || t == "image" || t == "photo" {
		return false
	}
	if t == "reel" || t == "video" {
		return true
	}
	if strings.Contains(strings.ToLower(it.Permalink), "/reel/") {
		return true
	}
	if it.IsVideo != nil && *it.IsVideo {
		return true
	}
	return false
}

// resolvePerShortcode returns whether to keep one file per shortcode.
// -all-frames is the explicit negative: it always wins over the -per-shortcode default.
func resolvePerShortcode(perShortcode, allFrames bool) bool {
	if allFrames {
		return false
	}
	return perShortcode
}

func collectJobs(prof *profileJSON, mediaDir string, perShortcode, includeStills, skipReels bool) ([]job, error) {
	videoChecks := map[string]bool{}
	usable := func(path string) bool {
		if mediaTypeOf(path) != "video" {
			return true
		}
		if ok, checked := videoChecks[path]; checked {
			return ok
		}
		ok := hasVideoPackets(path)
		videoChecks[path] = ok
		if !ok {
			fmt.Printf("warn: ignoring video without readable packets: %s\n", path)
		}
		return ok
	}
	mediaIndex, err := readOwnedMediaIndex(mediaDir)
	if err != nil {
		return nil, err
	}

	var jobs []job
	seen := map[string]struct{}{}
	ownedBySC := map[string][]string{}

	appendJob := func(id, kind, path string, it item) error {
		if _, ok := seen[id]; ok {
			return nil
		}
		sourceSHA, err := fileSHA256(path)
		if err != nil {
			return err
		}
		seen[id] = struct{}{}
		jobs = append(jobs, job{
			ID: id, Kind: kind, LocalPath: path, MediaType: mediaTypeOf(path),
			Caption: it.Caption, Permalink: it.Permalink, Shortcode: it.Shortcode,
			SourceSHA: sourceSHA,
		})
		return nil
	}

	addItem := func(it item, kind string) error {
		sc := it.Shortcode
		if sc == "" {
			sc = "unknown"
		}
		it.Shortcode = sc
		paths, err := selectOwnedMedia(it, mediaIndex, usable)
		if err != nil {
			return err
		}
		ownedBySC[sc] = appendUniquePaths(ownedBySC[sc], paths...)
		path := preferredOwnedPath(paths)
		mt := mediaTypeOf(path)
		if mt != "video" && (kind == "reel" || strings.EqualFold(it.Type, "reel") || strings.EqualFold(it.Type, "video")) {
			// Surface the gap clearly in logs — Qwen will only see a still unless video was downloaded
			fmt.Printf("warn: %s is %s but no local video file; using still %s (re-scrape with detail video harvest)\n",
				sc, kind, filepath.Base(path))
		}
		if perShortcode {
			return appendJob(sc, kind, path, it)
		}
		for _, ownedPath := range paths {
			id := sc + "__" + filepath.Base(ownedPath)
			if err := appendJob(id, kind, ownedPath, it); err != nil {
				return err
			}
		}
		return nil
	}

	for _, it := range prof.Posts {
		if skipReels && isReelOrVideoPost(it) {
			continue
		}
		if err := addItem(it, "post"); err != nil {
			return nil, err
		}
	}
	if !skipReels {
		for _, it := range prof.Reels {
			if err := addItem(it, "reel"); err != nil {
				return nil, err
			}
		}
	}

	if perShortcode && includeStills {
		uniqueDir := home.Path("data", prof.Username+"-unique")
		if st, err := os.Stat(uniqueDir); err != nil || !st.IsDir() {
			uniqueDir = ""
		}
		addStill := func(it item, kind string) error {
			sc := it.Shortcode
			if sc == "" {
				return nil
			}
			stills := stillsForShortcode(sc, uniqueDir, ownedBySC[sc])
			for i, f := range stills {
				id := sc + "__still"
				if len(stills) > 1 {
					id = fmt.Sprintf("%s__still_%02d", sc, i+1)
				}
				if _, ok := seen[id]; ok {
					continue
				}
				copy := it
				copy.Shortcode = sc
				if err := appendJob(id, kind, f, copy); err != nil {
					return err
				}
			}
			return nil
		}
		for _, it := range prof.Posts {
			if skipReels && isReelOrVideoPost(it) {
				continue
			}
			if err := addStill(it, "post"); err != nil {
				return nil, err
			}
		}
		if !skipReels {
			for _, it := range prof.Reels {
				if err := addStill(it, "reel"); err != nil {
					return nil, err
				}
			}
		}
	}

	sort.Slice(jobs, func(i, j int) bool { return jobs[i].ID < jobs[j].ID })
	return jobs, nil
}

func assetKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.Path
}

func readOwnedMediaIndex(mediaDir string) (map[string][]string, error) {
	raw, err := os.ReadFile(filepath.Join(mediaDir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("media ownership manifest: %w", err)
	}
	var manifest manifestFile
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("media ownership manifest: %w", err)
	}
	base, err := filepath.Abs(mediaDir)
	if err != nil {
		return nil, err
	}
	index := map[string][]string{}
	add := func(rawURL, local string) {
		key := assetKey(rawURL)
		if key == "" || local == "" {
			return
		}
		abs, err := filepath.Abs(local)
		if err != nil {
			return
		}
		rel, err := filepath.Rel(base, abs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return
		}
		index[key] = appendUniquePaths(index[key], local)
	}
	for _, result := range manifest.Results {
		if result.Status == "ok" || result.Status == "skipped" {
			add(result.URL, result.Local)
		}
	}
	for rawURL, local := range manifest.ByURL {
		add(rawURL, local)
	}
	return index, nil
}

func selectOwnedMedia(it item, index map[string][]string, usable func(string) bool) ([]string, error) {
	groups := [][]string{}
	if it.MediaOwnershipVersion == 1 {
		if len(it.CarouselMedia) > 0 {
			for _, slide := range it.CarouselMedia {
				groups = append(groups, []string{stringValue(slide.MediaURL), stringValue(slide.ThumbnailURL)})
			}
		} else {
			groups = append(groups, append(append([]string{}, it.MediaURLs...), stringValue(it.ThumbnailURL)))
		}
	} else if strings.EqualFold(it.Type, "carousel") || isReelOrVideoPost(it) {
		return nil, fmt.Errorf("%s: legacy video/carousel has no verified media ownership; collect this post again", it.Shortcode)
	} else if it.ThumbnailURL != nil {
		groups = append(groups, []string{*it.ThumbnailURL})
	} else {
		return nil, fmt.Errorf("%s: no verified media or cover; collect this post again", it.Shortcode)
	}

	selected := []string{}
	for _, group := range groups {
		candidates := []string{}
		for _, rawURL := range group {
			variants := index[assetKey(rawURL)]
			localVariants := []string{}
			for _, local := range variants {
				if filepath.Base(filepath.Dir(local)) == it.Shortcode {
					localVariants = append(localVariants, local)
				}
			}
			if len(localVariants) > 0 {
				variants = localVariants
			}
			for _, local := range variants {
				if usable(local) {
					candidates = appendUniquePaths(candidates, local)
				}
			}
		}
		sort.SliceStable(candidates, func(i, j int) bool {
			vi, vj := mediaTypeOf(candidates[i]) == "video", mediaTypeOf(candidates[j]) == "video"
			if vi != vj {
				return vi
			}
			si, sj := fileSize(candidates[i]), fileSize(candidates[j])
			if si != sj {
				return si > sj
			}
			return candidates[i] < candidates[j]
		})
		if len(candidates) == 0 {
			return nil, fmt.Errorf("%s: no downloaded file matches an owned media asset", it.Shortcode)
		}
		selected = appendUniquePaths(selected, candidates[0])
	}
	if len(selected) == 0 {
		return nil, fmt.Errorf("%s: no downloaded file matches an owned media asset", it.Shortcode)
	}
	return selected, nil
}

func preferredOwnedPath(paths []string) string {
	for _, path := range paths {
		if mediaTypeOf(path) == "video" {
			return path
		}
	}
	return paths[0]
}

func appendUniquePaths(paths []string, additions ...string) []string {
	for _, addition := range additions {
		if addition == "" {
			continue
		}
		found := false
		for _, old := range paths {
			if old == addition {
				found = true
				break
			}
		}
		if !found {
			paths = append(paths, addition)
		}
	}
	return paths
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// DASH initialization files can advertise a video stream without containing
// frames; media fragments can be large but unreadable without their init file.
func hasVideoPackets(path string) bool {
	return videoprobe.HasVideoPackets(path)
}

func stillsForShortcode(sc, uniqueDir string, mediaFiles []string) []string {
	var out []string
	if uniqueDir != "" {
		raw, err := os.ReadFile(filepath.Join(uniqueDir, "manifest.json"))
		var manifest uniqueManifest
		if err == nil && json.Unmarshal(raw, &manifest) == nil {
			for _, entry := range append(manifest.Files, manifest.Stills...) {
				if entry.Shortcode != sc || mediaTypeOf(entry.Dest) != "image" {
					continue
				}
				if st, err := os.Stat(entry.Dest); err == nil && !st.IsDir() {
					out = appendUniquePaths(out, entry.Dest)
				}
			}
		}
	}
	if len(out) > 0 {
		sort.Strings(out)
		return out
	}
	for _, f := range mediaFiles {
		if mediaTypeOf(f) != "image" {
			continue
		}
		if strings.ToLower(filepath.Ext(f)) == ".gif" {
			continue
		}
		out = appendUniquePaths(out, f)
	}
	sort.Strings(out)
	return out
}

func mediaTypeOf(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".mp4", ".mov", ".webm", ".mkv", ".avi":
		return "video"
	default:
		return "image"
	}
}

func fileSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

func loadPriorOK(outDir string) map[string]analysisResult {
	out := map[string]analysisResult{}
	aggPath := filepath.Join(outDir, "analysis.json")
	raw, err := os.ReadFile(aggPath)
	if err == nil {
		var agg struct {
			Items []analysisResult `json:"items"`
		}
		if json.Unmarshal(raw, &agg) == nil {
			for _, r := range agg.Items {
				if r.Status == "ok" && r.ID != "" {
					out[r.ID] = r
				}
			}
		}
	}
	// The aggregate may be from an earlier run. Item checkpoints are newer
	// whenever a run stops before it can replace analysis.json.
	itemsDir := filepath.Join(outDir, "items")
	entries, _ := os.ReadDir(itemsDir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(itemsDir, e.Name()))
		if err != nil {
			continue
		}
		var r analysisResult
		if json.Unmarshal(b, &r) == nil && r.Status == "ok" && r.ID != "" {
			out[r.ID] = r
		}
	}
	return out
}

func cacheMatches(prior analysisResult, current job, model, baseURL string) bool {
	if prior.AnalysisMethod == sampledFramesMethod && prior.MethodVersion != sampledFramesVersion {
		return false
	}
	return prior.Status == "ok" && prior.InputHash != "" && prior.InputHash == analysisInputHash(current, model, baseURL)
}

func analysisInputHash(j job, model, baseURL string) string {
	h := sha256.New()
	for _, part := range []string{
		"iganalyze-input-v1", analysisSystem, model, chatCompletionsURL(baseURL), buildUserPrompt(j),
		j.Kind, j.MediaType, j.Shortcode, j.SourceSHA,
	} {
		_, _ = io.WriteString(h, strconv.Itoa(len(part)))
		_, _ = io.WriteString(h, ":")
		_, _ = io.WriteString(h, part)
		_, _ = io.WriteString(h, "\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

func runPool(client *http.Client, apiKey, baseURL, model, outDir string, jobs []job, workers int) ([]analysisResult, error) {
	return runPoolWithRetryWait(client, apiKey, baseURL, model, outDir, jobs, workers, time.Sleep)
}

func runPoolWithRetryWait(client *http.Client, apiKey, baseURL, model, outDir string, jobs []job, workers int, retryWait func(time.Duration)) ([]analysisResult, error) {
	jobCh := make(chan job)
	resCh := make(chan analysisResult)
	stopDispatch := make(chan struct{})
	var stopRequested atomic.Bool
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			stopRequested.Store(true)
			close(stopDispatch)
		})
	}
	var done atomic.Int64
	total := int64(len(jobs))

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobCh {
				if stopRequested.Load() {
					continue
				}
				resCh <- analyzeOneWithRetry(client, apiKey, baseURL, model, j, retryWait)
				n := done.Add(1)
				if n%3 == 0 || n == total {
					fmt.Printf("progress: %d/%d\n", n, total)
				}
			}
		}()
	}

	results := make([]analysisResult, 0, len(jobs))
	var checkpointErr error
	var providerErr *providerFailureError
	var collectWg sync.WaitGroup
	collectWg.Add(1)
	go func() {
		defer collectWg.Done()
		for r := range resCh {
			results = append(results, r)
			if r.ProviderFailure != "" && providerErr == nil {
				providerErr = &providerFailureError{Kind: r.ProviderFailure, Status: r.ProviderStatus}
				fmt.Fprintf(os.Stderr, "error: %v; stopping new jobs\n", providerErr)
				stop()
			}
			if err := writeItemJSON(outDir, r); err != nil && checkpointErr == nil {
				checkpointErr = fmt.Errorf("%s: %w", r.ID, err)
				fmt.Fprintf(os.Stderr, "error: checkpoint analysis: %v; stopping new jobs\n", checkpointErr)
				stop()
			}
			if r.Status == "ok" {
				fmt.Printf("  ok  %s (%s)\n", r.ID, r.MediaType)
			} else {
				fmt.Printf("  err %s: %s\n", r.ID, r.Error)
			}
		}
	}()

dispatch:
	for _, j := range jobs {
		if stopRequested.Load() {
			break
		}
		select {
		case <-stopDispatch:
			break dispatch
		case jobCh <- j:
		}
	}
	close(jobCh)
	wg.Wait()
	close(resCh)
	collectWg.Wait()
	if checkpointErr != nil {
		if providerErr != nil {
			return results, errors.Join(checkpointErr, providerErr)
		}
		return results, checkpointErr
	}
	if providerErr != nil {
		return results, providerErr
	}
	return results, nil
}

func analyzeOne(client *http.Client, apiKey, baseURL, model string, j job) analysisResult {
	return analyzeOneWithRetry(client, apiKey, baseURL, model, j, time.Sleep)
}

func analyzeOneWithRetry(client *http.Client, apiKey, baseURL, model string, j job, retryWait func(time.Duration)) analysisResult {
	now := time.Now().UTC().Format(time.RFC3339)
	inputHash := analysisInputHash(j, model, baseURL)
	dataURL, mime, err := fileToDataURL(j.LocalPath)
	if err != nil {
		return analysisResult{
			ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
			MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
			Status: "error", Error: err.Error(), AnalyzedAt: now, InputHash: inputHash,
		}
	}

	userPrompt := buildUserPrompt(j)
	var content any
	if j.MediaType == "video" {
		content = []map[string]any{
			{"type": "text", "text": userPrompt},
			{"type": "video_url", "video_url": map[string]any{"url": dataURL}, "fps": 1},
		}
	} else {
		content = []map[string]any{
			{"type": "text", "text": userPrompt},
			{"type": "image_url", "image_url": map[string]any{"url": dataURL}},
		}
	}
	_ = mime

	body := map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "system", "content": analysisSystem},
			{"role": "user", "content": content},
		},
		"max_completion_tokens": 2048,
		"temperature":           0.3,
		"enable_thinking":       false,
	}

	raw, status, err := postAnalysisWithRetry(client, chatCompletionsURL(baseURL), apiKey, body, retryWait)
	if err != nil {
		return analysisResult{
			ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
			MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
			Status: "error", Error: err.Error(), AnalyzedAt: now, Model: model, InputHash: inputHash,
		}
	}
	if j.MediaType == "video" && isTooShortVideoRejection(status, raw) {
		return analyzeSampledVideoFrames(client, apiKey, baseURL, model, j, now, inputHash, retryWait)
	}
	return analysisResponseResult(j, now, model, inputHash, status, raw)
}

func postAnalysisWithRetry(client *http.Client, endpoint, apiKey string, body any, retryWait func(time.Duration)) ([]byte, int, error) {
	const attempts = 4
	var raw []byte
	var status int
	var err error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			retryWait(time.Duration(5*(1<<(attempt-1))) * time.Second)
		}
		raw, status, err = postJSON(client, endpoint, apiKey, body)
		if err == nil && status != http.StatusTooManyRequests && status < 500 {
			break
		}
	}
	return raw, status, err
}

func analysisResponseResult(j job, now, model, inputHash string, status int, raw []byte) analysisResult {
	if status < 200 || status >= 300 {
		return httpFailureResult(j, now, model, inputHash, status, raw)
	}
	text, err := extractAssistantText(raw)
	if err != nil {
		return analysisResult{
			ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
			MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
			Status: "error", Error: err.Error(), AnalyzedAt: now, Model: model, RawText: string(raw), InputHash: inputHash,
		}
	}
	cleaned := stripThink(text)
	js := extractJSONObject(cleaned)
	var analysis json.RawMessage
	if js != "" && json.Valid([]byte(js)) {
		analysis = json.RawMessage(js)
	} else {
		b, _ := json.Marshal(map[string]any{"summary": cleaned, "confidence": 0.4})
		analysis = b
	}
	return analysisResult{
		ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
		MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
		Status: "ok", Model: model, AnalyzedAt: now, Analysis: analysis, RawText: cleaned, InputHash: inputHash,
	}
}

func isTooShortVideoRejection(status int, raw []byte) bool {
	if status != http.StatusBadRequest {
		return false
	}
	message := strings.ToLower(string(raw))
	return strings.Contains(message, "video modality input does not meet the requirements") &&
		strings.Contains(message, "video file is too short")
}

func analyzeSampledVideoFrames(client *http.Client, apiKey, baseURL, model string, j job, now, inputHash string, retryWait func(time.Duration)) analysisResult {
	decorate := func(r analysisResult, frameCount int) analysisResult {
		r.AnalysisMethod = sampledFramesMethod
		r.MethodVersion = sampledFramesVersion
		r.FrameCount = frameCount
		r.Limitations = sampledFramesLimitations
		return r
	}
	frames, err := sampleVideoFrameDataURLs(j.LocalPath)
	if err != nil {
		return decorate(analysisResult{
			ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
			MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
			Status: "error", Error: fmt.Sprintf("native video rejected as too short; frame sampling failed: %v", err),
			AnalyzedAt: now, Model: model, InputHash: inputHash,
		}, 0)
	}
	content := []map[string]any{{"type": "text", "text": buildSampledVideoFramesPrompt(j, len(frames))}}
	for _, frame := range frames {
		content = append(content, map[string]any{"type": "image_url", "image_url": map[string]any{"url": frame}})
	}
	body := map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "system", "content": analysisSystem + "\nFor sampled video frames, describe only visible evidence. Do not infer audio, unseen motion, cuts, or pacing."},
			{"role": "user", "content": content},
		},
		"max_completion_tokens": 2048,
		"temperature":           0.3,
		"enable_thinking":       false,
	}
	raw, status, err := postAnalysisWithRetry(client, chatCompletionsURL(baseURL), apiKey, body, retryWait)
	if err != nil {
		return decorate(analysisResult{
			ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
			MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
			Status: "error", Error: err.Error(), AnalyzedAt: now, Model: model, InputHash: inputHash,
		}, len(frames))
	}
	return decorate(analysisResponseResult(j, now, model, inputHash, status, raw), len(frames))
}

func buildSampledVideoFramesPrompt(j job, frameCount int) string {
	var b strings.Builder
	b.WriteString("Analyze this Instagram ")
	b.WriteString(j.Kind)
	b.WriteString(" from ")
	b.WriteString(strconv.Itoa(frameCount))
	b.WriteString(" chronologically ordered still frames sampled from a short video.\n")
	if j.Shortcode != "" {
		b.WriteString("shortcode: ")
		b.WriteString(j.Shortcode)
		b.WriteString("\n")
	}
	if j.Permalink != "" {
		b.WriteString("permalink: ")
		b.WriteString(j.Permalink)
		b.WriteString("\n")
	}
	if j.Caption != "" {
		b.WriteString("caption (may include engagement metadata):\n")
		b.WriteString(j.Caption)
		b.WriteString("\n")
	}
	b.WriteString("Frames are in first-to-last order, with a middle frame when available. Describe visible composition and changes between these sampled frames only. Motion between frames, pacing, cuts, and audio are unknown; do not infer them. Return JSON only per system schema.")
	return b.String()
}

func sampleVideoFrameDataURLs(path string) ([]string, error) {
	count, err := countVideoFrames(path)
	if err != nil {
		return nil, err
	}
	indices := []int{}
	for _, index := range []int{0, (count - 1) / 2, count - 1} {
		if len(indices) == 0 || indices[len(indices)-1] != index {
			indices = append(indices, index)
		}
	}
	dir, err := os.MkdirTemp("", "iganalyze-frames-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	frames := make([]string, 0, len(indices))
	for i, index := range indices {
		framePath := filepath.Join(dir, fmt.Sprintf("frame-%02d.jpg", i+1))
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0",
			"-vf", fmt.Sprintf("select=eq(n\\,%d)", index), "-frames:v", "1", "-q:v", "3", "-an", "-y", framePath)
		output, runErr := cmd.CombinedOutput()
		cancel()
		if runErr != nil {
			return nil, fmt.Errorf("ffmpeg frame %d: %v: %s", index, runErr, truncate(string(output), 240))
		}
		dataURL, _, err := fileToDataURL(framePath)
		if err != nil {
			return nil, fmt.Errorf("frame %d: %w", index, err)
		}
		frames = append(frames, dataURL)
	}
	return frames, nil
}

func countVideoFrames(path string) (int, error) {
	return videoprobe.CountFrames(path)
}

func httpFailureResult(j job, now, model, inputHash string, status int, raw []byte) analysisResult {
	return analysisResult{
		ID: j.ID, Shortcode: j.Shortcode, Kind: j.Kind, LocalPath: j.LocalPath,
		MediaType: j.MediaType, Caption: j.Caption, Permalink: j.Permalink,
		Status: "error", Error: fmt.Sprintf("HTTP %d: %s", status, truncate(string(raw), 400)),
		AnalyzedAt: now, Model: model, InputHash: inputHash,
		ProviderFailure: providerFailureKind(status, raw), ProviderStatus: status,
	}
}

func providerFailureKind(status int, raw []byte) string {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "auth"
	}
	if status != http.StatusTooManyRequests {
		return ""
	}
	message := strings.ToLower(string(raw))
	normalized := strings.NewReplacer("_", " ", "-", " ").Replace(message)
	for _, marker := range []string{
		"insufficient quota", "quota exhaust", "quota deplet", "quotaexhaust",
		"token plan usage limit", "subscription limit", "out of credits",
		"credit balance", "billing hard limit",
	} {
		if strings.Contains(normalized, marker) {
			return "quota"
		}
	}
	compact := strings.Join(strings.Fields(message), "")
	for _, marker := range []string{
		`"code":2056`, `"code":"2056"`, "insufficientquota", "tokenplanusagelimit",
	} {
		if strings.Contains(compact, marker) {
			return "quota"
		}
	}
	return ""
}

func buildUserPrompt(j job) string {
	var b strings.Builder
	b.WriteString("Analyze this Instagram ")
	b.WriteString(j.Kind)
	b.WriteString(" media for brand/style extraction.\n")
	if j.Shortcode != "" {
		b.WriteString("shortcode: ")
		b.WriteString(j.Shortcode)
		b.WriteString("\n")
	}
	if j.Permalink != "" {
		b.WriteString("permalink: ")
		b.WriteString(j.Permalink)
		b.WriteString("\n")
	}
	if j.Caption != "" {
		b.WriteString("caption (may include engagement metadata):\n")
		b.WriteString(j.Caption)
		b.WriteString("\n")
	}
	if j.MediaType == "video" {
		b.WriteString("This is VIDEO input. Use native video understanding: describe motion, pacing, cuts, on-screen action, and audio-relevant visual beats.\n")
	} else {
		b.WriteString("This is a STILL / key frame. Describe composition, palette, lighting, and on-image text in detail.\n")
	}
	b.WriteString("Return JSON only per system schema.")
	return b.String()
}

func fileToDataURL(path string) (dataURL, mime string, err error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".jpg", ".jpeg":
		mime = "image/jpeg"
	case ".png":
		mime = "image/png"
	case ".webp":
		mime = "image/webp"
	case ".gif":
		mime = "image/gif"
	case ".mp4":
		mime = "video/mp4"
	case ".mov":
		mime = "video/mp4"
	case ".webm":
		mime = "video/webm"
	case ".mkv":
		mime = "video/x-matroska"
	default:
		mime = "application/octet-stream"
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	if strings.HasPrefix(mime, "video/") {
		if prefixLenPlus("data:"+mime+";base64,", len(raw)) > maxVideoEncoded {
			compressed, cerr := compressVideo(path, maxVideoEncoded)
			if cerr != nil {
				return "", "", fmt.Errorf("video exceeds %d encoded bytes and ffmpeg compress failed: %w", maxVideoEncoded, cerr)
			}
			raw = compressed
			mime = "video/mp4"
		}
		return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), mime, nil
	}
	if len(raw) > maxImageBytes {
		return "", "", fmt.Errorf("file too large (%d bytes > %d)", len(raw), maxImageBytes)
	}
	b64 := base64.StdEncoding.EncodeToString(raw)
	return "data:" + mime + ";base64," + b64, mime, nil
}

func prefixLenPlus(prefix string, rawLen int) int {
	return len(prefix) + base64.StdEncoding.EncodedLen(rawLen)
}

func compressVideo(src string, maxEncoded int) ([]byte, error) {
	targetRaw := int(float64(maxEncoded) * 0.72)
	tmp, err := os.CreateTemp("", "iganalyze-*.mp4")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpName)

	cmd := exec.Command("ffmpeg", "-y", "-i", src,
		"-vf", "scale='min(720,iw)':-2",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
		"-an", "-movflags", "+faststart",
		"-fs", fmt.Sprintf("%d", targetRaw),
		tmpName)
	var errBuf bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %v: %s", err, truncate(errBuf.String(), 240))
	}
	out, err := os.ReadFile(tmpName)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("ffmpeg produced empty file")
	}
	if prefixLenPlus("data:video/mp4;base64,", len(out)) > maxEncoded {
		return nil, fmt.Errorf("compressed video still too large (%d bytes)", len(out))
	}
	return out, nil
}

func postJSON(client *http.Client, url, apiKey string, body any) ([]byte, int, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return raw, resp.StatusCode, nil
}

func extractAssistantText(raw []byte) (string, error) {
	var resp struct {
		Choices []struct {
			Message struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent string          `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}
	if resp.Error.Message != "" {
		return "", fmt.Errorf("api error: %s", resp.Error.Message)
	}
	if resp.Code != "" && resp.Message != "" {
		return "", fmt.Errorf("api %s: %s", resp.Code, resp.Message)
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("empty choices in response")
	}
	text := decodeMessageContent(resp.Choices[0].Message.Content)
	if text == "" {
		text = strings.TrimSpace(resp.Choices[0].Message.ReasoningContent)
	}
	if text == "" {
		return "", fmt.Errorf("empty choices in response")
	}
	return text, nil
}

func decodeMessageContent(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return strings.TrimSpace(b.String())
	}
	return ""
}

func stripThink(s string) string {
	// Remove <think>...</think> blocks if thinking leaked into content
	for {
		start := strings.Index(s, "<think>")
		if start < 0 {
			break
		}
		end := strings.Index(s[start:], "</think>")
		if end < 0 {
			s = s[:start]
			break
		}
		s = s[:start] + s[start+end+len("</think>"):]
	}
	return strings.TrimSpace(s)
}

func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```")
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}

func writeItemJSON(outDir string, r analysisResult) error {
	dir := filepath.Join(outDir, "items")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	name := sanitize(r.ID) + ".json"
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".item-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, name))
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func buildStyleDigest(user string, prof *profileJSON, results []analysisResult) string {
	var b strings.Builder
	b.WriteString("# Style digest — @")
	b.WriteString(user)
	b.WriteString("\n\n")
	if prof.FullName != "" {
		b.WriteString("**Name:** ")
		b.WriteString(prof.FullName)
		b.WriteString("\n\n")
	}
	if prof.BioRaw != "" {
		b.WriteString("**Bio:**\n\n")
		b.WriteString(prof.BioRaw)
		b.WriteString("\n\n")
	}
	if prof.Location != "" {
		b.WriteString("**Location:** ")
		b.WriteString(prof.Location)
		b.WriteString("\n\n")
	}
	b.WriteString("## Per-item analyses\n\n")
	ok := 0
	for _, r := range results {
		if r.Status != "ok" {
			continue
		}
		ok++
		b.WriteString("### ")
		b.WriteString(r.ID)
		b.WriteString(" (")
		b.WriteString(r.Kind)
		b.WriteString(" / ")
		b.WriteString(r.MediaType)
		b.WriteString(")\n\n")
		if r.Caption != "" {
			b.WriteString("> ")
			b.WriteString(truncate(r.Caption, 280))
			b.WriteString("\n\n")
		}
		if len(r.Analysis) > 0 {
			b.WriteString("```json\n")
			b.Write(r.Analysis)
			b.WriteString("\n```\n\n")
		}
	}
	b.WriteString(fmt.Sprintf("\n_Analyzed items: %d_\n", ok))
	return b.String()
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	out := b.String()
	if out == "" {
		return "item"
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}
