package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Exercise the real command against two posts with different covers and the
// same larger recommendation, as in the September 8 scrape manifests.
func TestImageOwnership(t *testing.T) {
	if os.Getenv("IGUNIQUE_TEST_CHILD") == "1" {
		flag.CommandLine = flag.NewFlagSet("igunique", flag.ExitOnError)
		os.Args = append([]string{"igunique"}, os.Args[3:]...)
		main()
		return
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	dir := t.TempDir()
	media := filepath.Join(dir, "media")
	out := filepath.Join(dir, "unique")
	profile := profileJSON{Username: "ownership"}
	results := []map[string]any{}
	for i, sc := range []string{"POST_A", "POST_B"} {
		postDir := filepath.Join(media, sc)
		if err := os.MkdirAll(postDir, 0755); err != nil {
			t.Fatal(err)
		}
		own := filepath.Join(postDir, "own.png")
		stray := filepath.Join(postDir, "recommendation.png")
		writeTestImage(t, own, 500, color.RGBA{R: uint8(80 + i*100), A: 255})
		writeTestImage(t, stray, 800, color.RGBA{G: 200, A: 255})
		u := "https://cdn.test/" + sc + ".png?signature=old"
		other := "https://cdn.test/recommendation.png?signature=" + sc
		profile.Posts = append(profile.Posts, mediaItem{Shortcode: strp(sc), Type: strp("image"), ThumbnailURL: strp("https://cdn.test/" + sc + ".png?signature=new"), MediaURLs: []string{u, other}})
		results = append(results, map[string]any{"url": u, "localPath": own, "status": "ok"}, map[string]any{"url": other, "localPath": stray, "status": "ok"})
	}
	writeTestJSON(t, filepath.Join(dir, "profile.json"), profile)
	writeTestJSON(t, filepath.Join(media, "manifest.json"), map[string]any{"results": results})
	cmd := exec.Command(os.Args[0], "-test.run=^TestImageOwnership$", "--", "-in", filepath.Join(dir, "profile.json"), "-media", media, "-out", out, "-no-stills")
	cmd.Env = append(os.Environ(), "IGUNIQUE_TEST_CHILD=1")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("command: %v\n%s", err, b)
	}
	var man outManifest
	b, err := os.ReadFile(filepath.Join(out, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &man); err != nil {
		t.Fatal(err)
	}
	if len(man.Files) != 2 {
		t.Fatalf("files=%d want 2", len(man.Files))
	}
	for _, f := range man.Files {
		if filepath.Base(f.Src) != "own.png" {
			t.Errorf("%s selected %s; want its own cover", f.Shortcode, filepath.Base(f.Src))
		}
	}
	if man.Files[0].SHA == man.Files[1].SHA {
		t.Error("distinct posts selected identical recommendation bytes")
	}
	// A real reuse of the same owned image should retain both post references
	// while leaving only one physical output, including after a prior run.
	a, err := os.ReadFile(filepath.Join(media, "POST_A", "own.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(media, "POST_B", "own.png"), a, 0644); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(out, "user.txt"), []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(os.Args[0], "-test.run=^TestImageOwnership$", "--", "-in", filepath.Join(dir, "profile.json"), "-media", media, "-out", out, "-no-stills")
	cmd.Env = append(os.Environ(), "IGUNIQUE_TEST_CHILD=1")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("second run: %v\n%s", err, b)
	}
	b, err = os.ReadFile(filepath.Join(out, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &man); err != nil {
		t.Fatal(err)
	}
	if len(man.Files) != 2 || man.Files[0].Dest != man.Files[1].Dest {
		t.Fatalf("shared references=%+v", man.Files)
	}
	active, _ := filepath.Glob(filepath.Join(out, "*.png"))
	if len(active) != 1 {
		t.Fatalf("active image files=%v", active)
	}
	if _, err = os.Stat(filepath.Join(out, "user.txt")); err != nil {
		t.Fatal(err)
	}
}

func writeTestImage(t *testing.T, path string, size int, c color.RGBA) {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			im.SetRGBA(x, y, c)
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, im); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeTestJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestTitleFromCaption(t *testing.T) {
	cases := map[string]string{
		`863 likes, 7 comments - prettydios on August 21, 2026: "THE LOVERS.". `: "THE LOVERS",
		`122K likes, 594 comments - prettydios on July 24, 2026: "FALLING.". `:   "FALLING",
		`"FAITH."`:                       "FAITH",
		`THE ABYSS.`:                     "THE ABYSS",
		``:                               "",
		`a casual caption with no title`: "",
		`"hi"`:                           "",
	}
	for in, want := range cases {
		if got := titleFromCaption(in); got != want {
			t.Errorf("titleFromCaption(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSlugTitle(t *testing.T) {
	if got := slugTitle("THE LOVERS"); got != "THE-LOVERS" {
		t.Fatalf("slugTitle THE LOVERS = %q", got)
	}
	if got := slugTitle("FAITH"); got != "FAITH" {
		t.Fatalf("slugTitle FAITH = %q", got)
	}
}

func TestDestName(t *testing.T) {
	got := destName(1, "DESCENSION", "DcqVoJVIiuN", 960, 720, "", ".mp4")
	want := "01_DESCENSION_DcqVoJVIiuN_960x720.mp4"
	if got != want {
		t.Fatalf("destName reel = %q, want %q", got, want)
	}
	got = destName(6, "THE LOVERS", "DcTY_kdiL5p", 960, 720, "_01", ".mp4")
	want = "06_THE-LOVERS_01_DcTY_kdiL5p_960x720.mp4"
	if got != want {
		t.Fatalf("destName carousel = %q, want %q", got, want)
	}
}

func TestIsPlayable(t *testing.T) {
	clip := probeInfo{Path: "clip.mp4", Width: 960, Height: 720, Dur: 0.2, Bytes: 29_612, StreamType: "video", Format: "mov,mp4,m4a,3gp,3g2,mj2", VideoPackets: 1}
	if !isPlayable(clip) {
		t.Fatal("small short clip with a readable packet should be playable")
	}
	clip.VideoPackets = 0
	if isPlayable(clip) {
		t.Fatal("DASH init should not be playable")
	}
	clip.VideoPackets = 1
	clip.Path = "poster.jpg"
	clip.Format = "image2"
	if isPlayable(clip) {
		t.Fatal("JPEG stream should not be playable")
	}
	clip.Path = "fake.mp4"
	if isPlayable(clip) {
		t.Fatal("image content with an MP4 name should not be playable")
	}
}

func TestProbeVideoPackets(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s required", tool)
		}
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "short.mp4")
	init := filepath.Join(dir, "init.mp4")
	poster := filepath.Join(dir, "poster.png")
	input := []string{"-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=10", "-c:v", "mpeg4"}
	for _, fixture := range []struct {
		path string
		args []string
	}{
		{clip, []string{"-frames:v", "2"}},
		{init, []string{"-frames:v", "0", "-movflags", "empty_moov+frag_keyframe"}},
	} {
		args := append(append([]string{}, input...), fixture.args...)
		args = append(args, "-f", "mp4", fixture.path)
		if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
			t.Fatalf("create %s: %v: %s", fixture.path, err, b)
		}
	}
	writeTestImage(t, poster, 32, color.RGBA{A: 255})
	short, err := probe(clip)
	if err != nil {
		t.Fatal(err)
	}
	if short.Bytes >= 100*1024 || short.Dur >= 0.5 || !isPlayable(short) {
		t.Fatalf("small valid video should be playable: %+v", short)
	}
	empty, err := probe(init)
	if err != nil {
		t.Fatal(err)
	}
	if empty.StreamType != "video" || empty.VideoPackets != 0 || isPlayable(empty) {
		t.Fatalf("empty MP4 init should be rejected: %+v", empty)
	}
	image, err := probe(poster)
	if err != nil {
		t.Fatal(err)
	}
	if isPlayable(image) {
		t.Fatalf("PNG must remain an image: %+v", image)
	}
	post := mediaItem{
		Shortcode: strp("SHORT"), Type: strp("video"), MediaOwnershipVersion: 1,
		MediaURLs: []string{"https://cdn.test/short.mp4"}, ThumbnailURL: strp("https://cdn.test/poster.png"),
	}
	selected, err := selectPostMedia(post, map[string][]string{"/short.mp4": {clip}, "/poster.png": {poster}})
	if err != nil || len(selected) != 1 || selected[0].Path != clip {
		t.Fatalf("small owned video should outrank its poster: %v, %+v", err, selected)
	}
}

func TestProbeNativeImagesWithoutFFprobe(t *testing.T) {
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "poster.png")
	jpegPath := filepath.Join(dir, "poster.jpg")
	writeTestImage(t, pngPath, 32, color.RGBA{R: 180, A: 255})
	f, err := os.Create(jpegPath)
	if err != nil {
		t.Fatal(err)
	}
	im := image.NewRGBA(image.Rect(0, 0, 32, 24))
	if err := jpeg.Encode(f, im, nil); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	for _, tc := range []struct {
		path   string
		codec  string
		width  int
		height int
	}{
		{pngPath, "png", 32, 32},
		{jpegPath, "mjpeg", 32, 24},
	} {
		got, err := probe(tc.path)
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b)
		if got.Width != tc.width || got.Height != tc.height || got.Codec != tc.codec || got.Bytes != int64(len(b)) || got.SHA != hex.EncodeToString(sum[:])[:16] || isPlayable(got) {
			t.Errorf("native image probe lost metadata: %+v", got)
		}
	}
}

func TestStillOffset(t *testing.T) {
	t0 := stillOffset(17.7)
	if t0 < 3.5 || t0 > 4.2 {
		t.Fatalf("stillOffset(17.7) = %v, want ~3.9", t0)
	}
	if stillOffset(0.2) != 0 {
		t.Fatalf("tiny duration should offset 0")
	}
}

func strp(s string) *string { return &s }

func TestIsReelOrVideoItem(t *testing.T) {
	if isReelOrVideoItem(mediaItem{Type: strp("image")}) {
		t.Fatal("image should be kept")
	}
	if isReelOrVideoItem(mediaItem{Type: strp("carousel")}) {
		t.Fatal("carousel should be kept")
	}
	if !isReelOrVideoItem(mediaItem{Type: strp("reel")}) {
		t.Fatal("reel should skip")
	}
	if !isReelOrVideoItem(mediaItem{Permalink: strp("https://www.instagram.com/u/reel/AbC/")}) {
		t.Fatal("reel permalink should skip")
	}
}

func TestCollectItemsSkipReels(t *testing.T) {
	p := profileJSON{
		Username: "x",
		Posts: []mediaItem{
			{Shortcode: strp("AAA"), Type: strp("image")},
			{Shortcode: strp("BBB"), Type: strp("video")},
			{Shortcode: strp("CCC"), Type: strp("carousel")},
		},
		Reels: []mediaItem{
			{Shortcode: strp("DDD"), Type: strp("reel")},
		},
	}
	got := collectItems(p, true)
	if len(got) != 2 {
		t.Fatalf("skip-reels items=%d want 2 (image+carousel)", len(got))
	}
	for _, it := range got {
		sc := itemShortcode(it)
		if sc == "BBB" || sc == "DDD" {
			t.Fatalf("skip-reels kept reel/video %s", sc)
		}
	}
	all := collectItems(p, false)
	if len(all) != 4 {
		t.Fatalf("all items=%d want 4", len(all))
	}
}
