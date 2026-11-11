// igunique — collect unique playable Instagram posts at highest complete resolution.
//
// Usage:
//
//	go run ./cmd/igunique -in data/profiles/user-profile.json -media data/media/user -out data/user-unique
//	go run ./cmd/igunique -in data/profiles/user-profile.json -skip-reels
//
// Resolves each post's owned assets through the download manifest, then ranks
// complete variants with ffprobe. Carousels retain each image/clip; identical
// content shares a file while preserving post references in out/manifest.json.
// Superseded manifest files move to the sibling -archive directory.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/lmist/patronum/internal/home"
	"github.com/lmist/patronum/internal/videoprobe"
)

type mediaItem struct {
	MediaOwnershipVersion int            `json:"mediaOwnershipVersion"`
	CarouselMedia         []carouselItem `json:"carouselMedia"`
	Shortcode             *string        `json:"shortcode"`
	ID                    *string        `json:"id"`
	Type                  *string        `json:"type"`
	Caption               *string        `json:"caption"`
	Timestamp             *string        `json:"timestamp"`
	Permalink             *string        `json:"permalink"`
	IsVideo               *bool          `json:"isVideo"`
	MediaURLs             []string       `json:"mediaUrls"`
	ThumbnailURL          *string        `json:"thumbnailUrl"`
}

type profileJSON struct {
	Username string      `json:"username"`
	Posts    []mediaItem `json:"posts"`
	Reels    []mediaItem `json:"reels"`
}

type probeInfo struct {
	Path         string
	Width        int
	Height       int
	Dur          float64
	Bytes        int64
	Codec        string
	StreamType   string
	Format       string
	VideoPackets int
	SHA          string
}

type fileEntry struct {
	Title      string  `json:"title"`
	Date       string  `json:"date,omitempty"`
	Shortcode  string  `json:"shortcode"`
	Kind       string  `json:"kind"`
	Src        string  `json:"src"`
	Dest       string  `json:"dest"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	DurationS  float64 `json:"duration_s,omitempty"`
	Bytes      int64   `json:"bytes"`
	Codec      string  `json:"codec,omitempty"`
	SHA        string  `json:"sha256_16,omitempty"`
	ExtractedS float64 `json:"extracted_at_s,omitempty"`
}

type outManifest struct {
	Username    string      `json:"username"`
	Source      string      `json:"source"`
	Out         string      `json:"out"`
	Note        string      `json:"note"`
	CountVideos int         `json:"count_videos"`
	CountStills int         `json:"count_stills"`
	Files       []fileEntry `json:"files"`
	Stills      []fileEntry `json:"stills"`
}

func main() {
	inPath := flag.String("in", "", "path to the collected profile JSON (data/profiles/<handle>-profile.json)")
	mediaDir := flag.String("media", "", "downloaded media dir (default: data/media/<username>)")
	outDir := flag.String("out", "", "output directory (default: data/<username>-unique)")
	fresh := flag.Bool("fresh", false, "wipe the output directory before writing")
	noStills := flag.Bool("no-stills", false, "skip ffmpeg still extraction")
	skipReels := flag.Bool("skip-reels", false, "skip reels and standalone videos; image + carousel posts only")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "Usage: patronum unique -in <profile.json> [-media <media dir>] [-out <dir>] [options]")
		flag.PrintDefaults()
	}
	flag.Parse()

	if *inPath == "" {
		fmt.Fprintln(os.Stderr, "error: -in <profile.json> is required")
		flag.Usage()
		os.Exit(2)
	}

	raw, err := os.ReadFile(*inPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: read -in: %v\n", err)
		os.Exit(1)
	}
	var profile profileJSON
	if err := json.Unmarshal(raw, &profile); err != nil {
		fmt.Fprintf(os.Stderr, "error: parse profile JSON: %v\n", err)
		os.Exit(1)
	}
	username := strings.TrimSpace(profile.Username)
	if username == "" {
		username = "unknown"
	}
	if *mediaDir == "" {
		*mediaDir = home.Path("data", "media", username)
	}
	if *outDir == "" {
		*outDir = home.Path("data", username+"-unique")
	}

	if _, err := os.Stat(*mediaDir); err != nil {
		fmt.Fprintf(os.Stderr, "error: media dir: %v\n", err)
		os.Exit(1)
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		fmt.Fprintln(os.Stderr, "error: ffprobe not on PATH")
		os.Exit(1)
	}
	haveFFMPEG := true
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		haveFFMPEG = false
		if !*noStills {
			fmt.Fprintln(os.Stderr, "igunique: ffmpeg not on PATH — videos only")
		}
	}

	if *fresh {
		if err := os.RemoveAll(*outDir); err != nil {
			fmt.Fprintf(os.Stderr, "error: wipe -out: %v\n", err)
			os.Exit(1)
		}
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "error: mkdir -out: %v\n", err)
		os.Exit(1)
	}

	if *skipReels {
		fmt.Println("igunique: -skip-reels — image + carousel posts only")
	}
	items := collectItems(profile, *skipReels)
	index, err := readMediaIndex(*mediaDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: media ownership index: %v\n", err)
		os.Exit(1)
	}
	previous, _ := os.ReadFile(filepath.Join(*outDir, "manifest.json"))
	selections := make([][]probeInfo, len(items))
	for i, it := range items {
		selections[i], err = selectPostMedia(it, index)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	}
	files := []fileEntry{}
	stills := []fileEntry{}
	masters := map[string]string{}
	n := 0
	for itemIndex, it := range items {
		sc := itemShortcode(it)
		if sc == "" || sc == "profile" {
			continue
		}
		kind := itemKind(it)
		chosen := selections[itemIndex]
		n++
		for j, selected := range chosen {
			suffix := ""
			if len(chosen) > 1 {
				suffix = fmt.Sprintf("_%02d", j+1)
			}
			if !isPlayable(selected) {
				img := selected
				title := titleFromCaption(deref(it.Caption))
				dest := filepath.Join(*outDir, destName(n, title, sc, img.Width, img.Height, suffix, strings.ToLower(filepath.Ext(img.Path))))
				if existing := masters[img.SHA]; existing != "" {
					dest = existing
				} else if err := copyFile(img.Path, dest); err != nil {
					fmt.Fprintf(os.Stderr, "igunique: copy %s: %v\n", sc, err)
					os.Exit(1)
				}
				masters[img.SHA] = dest
				files = append(files, fileEntry{
					Title:     titleOr(title, sc),
					Date:      itemDate(it),
					Shortcode: sc,
					Kind:      "image",
					Src:       img.Path,
					Dest:      dest,
					Width:     img.Width,
					Height:    img.Height,
					Bytes:     img.Bytes,
					Codec:     img.Codec,
					SHA:       img.SHA,
				})
				continue
			}
			v := selected
			title := titleFromCaption(deref(it.Caption))
			dest := destName(n, title, sc, v.Width, v.Height, suffix, ".mp4")
			outPath := filepath.Join(*outDir, dest)
			if existing := masters[v.SHA]; existing != "" {
				outPath = existing
			} else if err := copyFile(v.Path, outPath); err != nil {
				fmt.Fprintf(os.Stderr, "igunique: copy %s: %v\n", v.Path, err)
				os.Exit(1)
			}
			masters[v.SHA] = outPath
			entry := fileEntry{
				Title:     titleOr(title, sc),
				Date:      itemDate(it),
				Shortcode: sc,
				Kind:      kind,
				Src:       v.Path,
				Dest:      outPath,
				Width:     v.Width,
				Height:    v.Height,
				DurationS: round3(v.Dur),
				Bytes:     v.Bytes,
				Codec:     v.Codec,
				SHA:       v.SHA,
			}
			files = append(files, entry)
			if !*noStills && haveFFMPEG {
				stillName := strings.TrimSuffix(filepath.Base(outPath), ".mp4") + ".jpg"
				stillPath := filepath.Join(*outDir, stillName)
				t := stillOffset(v.Dur)
				if err := extractStill(outPath, stillPath, t); err != nil {
					fmt.Fprintf(os.Stderr, "igunique: still %s: %v\n", dest, err)
					continue
				}
				st, err := os.Stat(stillPath)
				if err != nil {
					continue
				}
				stills = append(stills, fileEntry{
					Title:      entry.Title,
					Date:       entry.Date,
					Shortcode:  sc,
					Kind:       "still",
					Src:        outPath,
					Dest:       stillPath,
					Width:      v.Width,
					Height:     v.Height,
					Bytes:      st.Size(),
					Codec:      "mjpeg",
					ExtractedS: round3(t),
				})
			}
		}
	}

	man := outManifest{
		Username:    username,
		Source:      *mediaDir,
		Out:         *outDir,
		Note:        "Post-owned media at highest complete resolution. Identical content shares a file while preserving each post reference. Superseded files are archived.",
		CountVideos: len(files),
		CountStills: len(stills),
		Files:       files,
		Stills:      stills,
	}
	// count_videos is playable videos + image-only copies
	nVid := 0
	for _, f := range files {
		if strings.HasSuffix(strings.ToLower(f.Dest), ".mp4") {
			nVid++
		}
	}
	man.CountVideos = nVid
	keep := map[string]bool{}
	for _, f := range append(files, stills...) {
		keep[filepath.Base(f.Dest)] = true
	}
	if err := archiveSuperseded(*outDir, previous, keep); err != nil {
		fmt.Fprintf(os.Stderr, "error: archive superseded media: %v\n", err)
		os.Exit(1)
	}

	blob, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: marshal manifest: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(filepath.Join(*outDir, "manifest.json"), append(blob, '\n'), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "error: write manifest: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("igunique: user=%s videos=%d stills=%d images=%d out=%s\n",
		username, man.CountVideos, len(stills), len(files)-man.CountVideos, *outDir)
	images := len(files) - man.CountVideos
	if images < 0 {
		images = 0
	}
	b, _ := json.Marshal(map[string]any{
		"ok": true, "dir": *outDir,
		"videos": man.CountVideos, "stills": len(stills), "images": images,
		"unique": man.CountVideos + len(stills) + images,
	})
	fmt.Println(string(b))
}

func collectItems(p profileJSON, skipReels bool) []mediaItem {
	seen := map[string]int{}
	var out []mediaItem
	add := func(it mediaItem) {
		sc := itemShortcode(it)
		if sc == "" {
			return
		}
		if i, ok := seen[sc]; ok {
			if len(it.MediaURLs) > len(out[i].MediaURLs) {
				out[i] = it
			}
			return
		}
		seen[sc] = len(out)
		out = append(out, it)
	}
	for _, it := range p.Posts {
		if skipReels && isReelOrVideoItem(it) {
			continue
		}
		add(it)
	}
	if !skipReels {
		for _, it := range p.Reels {
			add(it)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		ti, okI := parseTime(deref(out[i].Timestamp))
		tj, okJ := parseTime(deref(out[j].Timestamp))
		if okI && okJ && !ti.Equal(tj) {
			return ti.After(tj)
		}
		if okI != okJ {
			return okI
		}
		return itemShortcode(out[i]) > itemShortcode(out[j])
	})
	return out
}

func itemShortcode(it mediaItem) string {
	if it.Shortcode != nil && strings.TrimSpace(*it.Shortcode) != "" {
		return strings.TrimSpace(*it.Shortcode)
	}
	if it.ID != nil {
		return strings.TrimSpace(*it.ID)
	}
	return ""
}

// isReelOrVideoItem reports a reel or standalone feed video (not image/carousel).
func isReelOrVideoItem(it mediaItem) bool {
	t := strings.ToLower(deref(it.Type))
	if t == "carousel" || t == "image" || t == "photo" {
		return false
	}
	if t == "reel" || t == "video" {
		return true
	}
	if strings.Contains(strings.ToLower(deref(it.Permalink)), "/reel/") {
		return true
	}
	if it.IsVideo != nil && *it.IsVideo {
		return true
	}
	return false
}

func itemKind(it mediaItem) string {
	t := strings.ToLower(deref(it.Type))
	if t == "carousel" {
		return "carousel"
	}
	if t == "reel" || t == "video" {
		return "reel"
	}
	if t == "image" || t == "photo" {
		return "image"
	}
	if it.IsVideo != nil && *it.IsVideo {
		return "reel"
	}
	return "post"
}

func itemDate(it mediaItem) string {
	ts := deref(it.Timestamp)
	if t, ok := parseTime(ts); ok {
		return t.UTC().Format("2006-01-02")
	}
	return ""
}

func parseTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano, "2006-01-02T15:04:05.000Z", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func titleOr(title, sc string) string {
	if title == "" {
		return sc
	}
	return title
}

// titleFromCaption pulls the ALL-CAPS title IG puts in quotes, e.g.
// `863 likes … "THE LOVERS.". ` → "THE LOVERS".
func titleFromCaption(caption string) string {
	caption = strings.TrimSpace(caption)
	if caption == "" {
		return ""
	}
	quoted := lastQuoted(caption)
	if cand := cleanTitle(quoted); cand != "" {
		return cand
	}
	return cleanTitle(caption)
}

func lastQuoted(s string) string {
	last := ""
	start := -1
	for i, r := range s {
		if r == '"' {
			if start < 0 {
				start = i + 1
			} else {
				last = s[start:i]
				start = -1
			}
		}
	}
	return last
}

func cleanTitle(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `."'`)
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	letters := 0
	upper := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	if letters < 2 || letters > 40 {
		return ""
	}
	if upper*2 < letters {
		return ""
	}
	return strings.ToUpper(s)
}

func slugTitle(title string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range title {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(unicode.ToUpper(r))
			lastDash = false
		case r == ' ' || r == '_' || r == '-':
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func destName(index int, title, shortcode string, w, h int, slideSuffix, ext string) string {
	slug := slugTitle(title)
	base := fmt.Sprintf("%02d", index)
	if slug != "" {
		base += "_" + slug
	}
	base += slideSuffix + "_" + shortcode + fmt.Sprintf("_%dx%d", w, h) + ext
	return base
}

func stillOffset(dur float64) float64 {
	if dur <= 0.5 {
		return 0
	}
	t := dur * 0.22
	if t < 0.4 {
		t = 0.4
	}
	if t > dur-0.25 {
		t = dur - 0.25
	}
	if t < 0 {
		t = 0
	}
	return t
}

func isPlayable(p probeInfo) bool {
	if p.StreamType != "video" || p.VideoPackets < 1 || p.Width < 1 || p.Height < 1 {
		return false
	}
	switch strings.ToLower(filepath.Ext(p.Path)) {
	case ".mp4", ".mov", ".webm", ".mkv", ".avi":
	default:
		return false
	}
	for _, name := range strings.Split(p.Format, ",") {
		switch name {
		case "mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi":
			return true
		}
	}
	return false
}

func probe(path string) (probeInfo, error) {
	st, err := os.Stat(path)
	if err != nil {
		return probeInfo{}, err
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jpg", ".jpeg", ".png":
		return probeStaticImage(path, st.Size())
	}
	info := probeInfo{Path: path, Bytes: st.Size()}
	video, err := videoprobe.Describe(path)
	if err != nil {
		return info, err
	}
	info.Width = video.Width
	info.Height = video.Height
	info.Codec = video.Codec
	info.StreamType = video.StreamType
	info.VideoPackets = video.Packets
	info.Format = video.Format
	info.Dur = video.Duration
	sum, err := fileSHA(path)
	if err == nil {
		info.SHA = sum
	}
	return info, nil
}

func probeStaticImage(path string, size int64) (probeInfo, error) {
	info := probeInfo{Path: path, Bytes: size}
	f, err := os.Open(path)
	if err != nil {
		return info, err
	}
	config, format, decodeErr := image.DecodeConfig(f)
	closeErr := f.Close()
	if decodeErr != nil {
		return info, decodeErr
	}
	if closeErr != nil {
		return info, closeErr
	}
	info.Width, info.Height = config.Width, config.Height
	info.Codec = format
	if format == "jpeg" {
		info.Codec = "mjpeg"
	}
	info.SHA, err = fileSHA(path)
	return info, err
}

func fileSHA(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

func extractStill(video, dest string, t float64) error {
	cmd := exec.Command("ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
		"-i", video, "-ss", fmt.Sprintf("%.3f", t), "-frames:v", "1", "-q:v", "2", dest)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dest + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(tmp)
		return closeErr
	}
	return os.Rename(tmp, dest)
}

func round3(f float64) float64 {
	return float64(int(f*1000+0.5)) / 1000
}
