// Package igdl implements Instagram media job discovery, download, and manifests.
package igdl

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

func isVideoURL(u string) bool {
	ul := strings.ToLower(u)
	return strings.Contains(ul, ".mp4") ||
		strings.Contains(ul, ".m3u8") ||
		strings.Contains(ul, ".mov") ||
		strings.Contains(ul, ".webm") ||
		strings.Contains(ul, "video_dash") ||
		strings.Contains(ul, "/t50.")
}

// CarouselMedia is one item in a carousel post.
type CarouselMedia struct {
	MediaURL     *string `json:"mediaUrl"`
	ThumbnailURL *string `json:"thumbnailUrl"`
	IsVideo      *bool   `json:"isVideo"`
}

// MediaItem is the media subset of a scrape-profile result.
type MediaItem struct {
	Shortcode     *string         `json:"shortcode"`
	ID            *string         `json:"id"`
	Type          *string         `json:"type"`
	Permalink     *string         `json:"permalink"`
	IsVideo       *bool           `json:"isVideo"`
	MediaURLs     []string        `json:"mediaUrls"`
	ThumbnailURL  *string         `json:"thumbnailUrl"`
	CarouselMedia []CarouselMedia `json:"carouselMedia"`
}

// ProfileJSON is the scrape-profile JSON subset used by igdl.
type ProfileJSON struct {
	Username      string      `json:"username"`
	ProfilePicURL *string     `json:"profilePicUrl"`
	Posts         []MediaItem `json:"posts"`
	Reels         []MediaItem `json:"reels"`
}

// Job describes one media URL to download.
type Job struct {
	URL       string
	Shortcode string
	Index     int
	Kind      string
}

// Result records one download attempt.
type Result struct {
	URL      string `json:"url"`
	Local    string `json:"localPath"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
	HTTPCode int    `json:"httpCode,omitempty"`
	Filename string `json:"filename,omitempty"`
}

// Manifest records a run and maps completed URLs to local paths.
type Manifest struct {
	Username  string            `json:"username"`
	OutDir    string            `json:"outDir"`
	StartedAt string            `json:"startedAt"`
	EndedAt   string            `json:"endedAt"`
	Workers   int               `json:"workers"`
	Total     int               `json:"total"`
	OK        int               `json:"ok"`
	Skipped   int               `json:"skipped"`
	Failed    int               `json:"failed"`
	Results   []Result          `json:"results"`
	ByURL     map[string]string `json:"byUrl"`
}

func LoadPriorOK(outDir string) map[string]string {
	path := filepath.Join(outDir, "manifest.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return map[string]string{}
	}
	out := map[string]string{}
	if m.ByURL != nil {
		for u, local := range m.ByURL {
			out[u] = local
		}
	}
	// Accept ok + skipped-with-local so multi-run resume stays stable
	// (resume-skipped rows are written as status "skipped" but still on disk).
	for _, r := range m.Results {
		if (r.Status == "ok" || r.Status == "skipped") && r.URL != "" && r.Local != "" {
			out[r.URL] = r.Local
		}
	}
	return out
}

// MergeResults builds a full Result list for the Manifest without losing prior OK rows.
func MergeResults(priorOK map[string]string, resumeSkipped, downloaded []Result, fresh bool) []Result {
	seen := map[string]struct{}{}
	var out []Result

	add := func(r Result) {
		if r.URL == "" {
			return
		}
		if _, ok := seen[r.URL]; ok {
			return
		}
		seen[r.URL] = struct{}{}
		out = append(out, r)
	}

	for _, r := range downloaded {
		add(r)
	}
	for _, r := range resumeSkipped {
		add(r)
	}
	if !fresh {
		// Preserve prior OK that weren't in this Job set (orphans still useful)
		for u, local := range priorOK {
			if _, ok := seen[u]; ok {
				continue
			}
			if st, err := os.Stat(local); err == nil && st.Size() > 0 {
				add(Result{
					URL:      u,
					Local:    local,
					Status:   "ok",
					Filename: filepath.Base(local),
					Bytes:    st.Size(),
				})
			}
		}
	}
	return out
}

func CollectJobs(p *ProfileJSON, skipReels bool) []Job {
	var out []Job
	idx := map[string]int{} // shortcode → next index

	add := func(u, shortcode, kind string) {
		u = strings.TrimSpace(u)
		if u == "" || !isHTTPURL(u) {
			return
		}
		sc := shortcode
		if sc == "" {
			sc = "media"
		}
		i := idx[sc]
		idx[sc] = i + 1
		out = append(out, Job{URL: u, Shortcode: sc, Index: i, Kind: kind})
	}

	if p.ProfilePicURL != nil {
		add(*p.ProfilePicURL, "profile", "profile_pic")
	}

	addItem := func(it MediaItem, kind string) {
		sc := ""
		if it.Shortcode != nil && *it.Shortcode != "" {
			sc = *it.Shortcode
		} else if it.ID != nil {
			sc = *it.ID
		} else if it.Permalink != nil {
			sc = ShortcodeFromPermalink(*it.Permalink)
		}
		// Prefer video CDN URLs first so filenames _00_ are mp4 when present
		urls := append([]string{}, it.MediaURLs...)
		sort.SliceStable(urls, func(i, j int) bool {
			vi := isVideoURL(urls[i])
			vj := isVideoURL(urls[j])
			if vi != vj {
				return vi && !vj
			}
			return i < j
		})
		for _, u := range urls {
			add(u, sc, kind)
		}
		if it.ThumbnailURL != nil {
			add(*it.ThumbnailURL, sc, "thumb")
		}
		for _, c := range it.CarouselMedia {
			if c.MediaURL != nil {
				add(*c.MediaURL, sc, "carousel")
			}
			if c.ThumbnailURL != nil {
				add(*c.ThumbnailURL, sc, "carousel_thumb")
			}
		}
	}

	for _, it := range p.Posts {
		if skipReels && IsReelOrVideoItem(it) {
			continue
		}
		addItem(it, "post")
	}
	if !skipReels {
		for _, it := range p.Reels {
			addItem(it, "reel")
		}
	}
	return out
}

// IsReelOrVideoItem reports a reel or standalone feed video (not image/carousel).
func IsReelOrVideoItem(it MediaItem) bool {
	t := ""
	if it.Type != nil {
		t = strings.ToLower(strings.TrimSpace(*it.Type))
	}
	if t == "carousel" || t == "image" || t == "photo" {
		return false
	}
	if t == "reel" || t == "video" {
		return true
	}
	if it.Permalink != nil && strings.Contains(strings.ToLower(*it.Permalink), "/reel/") {
		return true
	}
	if it.IsVideo != nil && *it.IsVideo {
		return true
	}
	return false
}

func DedupeJobs(jobs []Job) []Job {
	seen := make(map[string]struct{}, len(jobs))
	var out []Job
	for _, j := range jobs {
		if _, ok := seen[j.URL]; ok {
			continue
		}
		seen[j.URL] = struct{}{}
		out = append(out, j)
	}
	return out
}

func isHTTPURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

func ShortcodeFromPermalink(permalink string) string {
	// /p/SHORT/ or /reel/SHORT/
	parts := strings.Split(permalink, "/")
	for i, p := range parts {
		if (p == "p" || p == "reel" || p == "tv") && i+1 < len(parts) {
			sc := parts[i+1]
			if sc != "" {
				return sc
			}
		}
	}
	return "media"
}

func DownloadOne(client *http.Client, outDir string, j Job) Result {
	if !isHTTPURL(j.URL) {
		return Result{URL: j.URL, Status: "skipped", Error: "empty or non-http URL"}
	}

	// A completed manifest entry makes this retry-safe without a network call.
	if local, ok := LoadPriorOK(outDir)[j.URL]; ok {
		if st, err := os.Stat(local); err == nil && st.Size() > 0 {
			return Result{
				URL: j.URL, Local: local, Status: "skipped",
				Error: "already downloaded (resume)", Filename: filepath.Base(local), Bytes: st.Size(),
			}
		}
	}

	req, err := http.NewRequest(http.MethodGet, j.URL, nil)
	if err != nil {
		return Result{URL: j.URL, Status: "error", Error: err.Error()}
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", "https://www.instagram.com/")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := client.Do(req)
	if err != nil {
		return Result{URL: j.URL, Status: "error", Error: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// drain
		_, _ = io.Copy(io.Discard, resp.Body)
		return Result{
			URL:      j.URL,
			Status:   "error",
			Error:    fmt.Sprintf("HTTP %d", resp.StatusCode),
			HTTPCode: resp.StatusCode,
		}
	}

	ext := extFromContentType(resp.Header.Get("Content-Type"))
	if ext == "" {
		ext = extFromURL(j.URL)
	}
	if ext == "" {
		ext = ".bin"
	}

	hash := shortHash(j.URL)
	rel := DestRelPath(j.Shortcode, j.Index, hash, ext)
	filename := filepath.Base(rel)
	localPath := filepath.Join(outDir, rel)
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return Result{URL: j.URL, Status: "error", Error: err.Error(), HTTPCode: resp.StatusCode}
	}

	f, err := os.Create(localPath)
	if err != nil {
		return Result{URL: j.URL, Status: "error", Error: err.Error(), HTTPCode: resp.StatusCode}
	}
	n, err := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if err != nil {
		_ = os.Remove(localPath)
		return Result{URL: j.URL, Status: "error", Error: err.Error(), HTTPCode: resp.StatusCode}
	}
	if closeErr != nil {
		return Result{URL: j.URL, Status: "error", Error: closeErr.Error(), HTTPCode: resp.StatusCode}
	}

	return Result{
		URL:      j.URL,
		Local:    localPath,
		Status:   "ok",
		Bytes:    n,
		HTTPCode: resp.StatusCode,
		Filename: filename,
	}
}

func extFromContentType(ct string) string {
	ct = strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
	switch ct {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/heic", "image/heif":
		return ".heic"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "video/quicktime":
		return ".mov"
	default:
		return ""
	}
}

func extFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	ext := strings.ToLower(path.Ext(u.Path))
	// strip query-like junk
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov", ".heic":
		if ext == ".jpeg" {
			return ".jpg"
		}
		return ext
	default:
		return ""
	}
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:10]
}

func sanitizeFilename(s string) string {
	if s == "" {
		return "media"
	}
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
		return "media"
	}
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

func DestRelPath(shortcode string, index int, hash, ext string) string {
	sc := sanitizeFilename(shortcode)
	name := fmt.Sprintf("%s_%02d_%s%s", sc, index, hash, ext)
	return filepath.Join(sc, name)
}

func nestPath(p string) string {
	if p == "" {
		return p
	}
	base := filepath.Base(p)
	sc := sanitizeFilename(shortcodeFromFilename(base))
	if sc == "" || sc == "." {
		return p
	}
	dir := filepath.Dir(p)
	if filepath.Base(dir) == sc {
		return p
	}
	return filepath.Join(dir, sc, base)
}

func shortcodeFromFilename(base string) string {
	// igdl names: {shortcode}_{NN}_{hash}.ext
	// Shortcodes may themselves end with '_' (e.g. DafszAlNQV_ → DafszAlNQV__00_abc.mp4).
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	if i := strings.LastIndex(stem, "_"); i > 0 {
		maybeHash := stem[i+1:]
		rest := stem[:i]
		if j := strings.LastIndex(rest, "_"); j > 0 {
			maybeIdx := rest[j+1:]
			if len(maybeIdx) == 2 && isAllDigits(maybeIdx) && len(maybeHash) >= 6 {
				return rest[:j]
			}
		}
	}
	parts := strings.Split(stem, "_")
	if len(parts) == 0 {
		return stem
	}
	return parts[0]
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

func isMediaFilename(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov", ".heic":
		return true
	default:
		return false
	}
}

// ReorganizeOutDir moves flat {shortcode}_{NN}_{hash}.ext files into
// outDir/<shortcode>/ and rewrites manifest.json paths. Idempotent.
func ReorganizeOutDir(outDir string) (int, error) {
	entries, err := os.ReadDir(outDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	moved := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if name == "manifest.json" || !isMediaFilename(name) {
			continue
		}
		src := filepath.Join(outDir, name)
		dest := nestPath(src)
		if dest == src {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return moved, err
		}
		if st, err := os.Stat(dest); err == nil && !st.IsDir() {
			_ = os.Remove(src)
			moved++
			continue
		}
		if err := os.Rename(src, dest); err != nil {
			return moved, err
		}
		moved++
	}

	if err := rewriteManifestPaths(outDir); err != nil {
		return moved, err
	}
	return moved, nil
}

func rewriteManifestPaths(outDir string) error {
	path := filepath.Join(outDir, "manifest.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	changed := false
	for i, r := range m.Results {
		next := nestPath(r.Local)
		if next != r.Local {
			m.Results[i].Local = next
			changed = true
		}
	}
	if m.ByURL != nil {
		for u, local := range m.ByURL {
			next := nestPath(local)
			if next != local {
				m.ByURL[u] = next
				changed = true
			}
		}
	}
	if !changed {
		return nil
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func WriteManifest(outDir, username string, workers int, results []Result, started, ended time.Time) (string, error) {
	okN, skipN, failN := 0, 0, 0
	byURL := make(map[string]string)
	if results == nil {
		results = []Result{}
	}
	for _, r := range results {
		switch r.Status {
		case "ok":
			okN++
			if r.Local != "" {
				byURL[r.URL] = r.Local
			}
		case "skipped":
			skipN++
			// Keep skipped-with-local in byUrl so the next resume does not re-download.
			if r.Local != "" {
				byURL[r.URL] = r.Local
			}
		default:
			failN++
		}
	}
	m := Manifest{
		Username:  username,
		OutDir:    outDir,
		StartedAt: started.UTC().Format(time.RFC3339),
		EndedAt:   ended.UTC().Format(time.RFC3339),
		Workers:   workers,
		Total:     len(results),
		OK:        okN,
		Skipped:   skipN,
		Failed:    failN,
		Results:   results,
		ByURL:     byURL,
	}
	path := filepath.Join(outDir, "manifest.json")
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
