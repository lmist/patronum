package main

import (
	"encoding/json"
	"image/color"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSelectMixedCarousel(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	dir := t.TempDir()
	video := filepath.Join(dir, "clip.mp4")
	poster := filepath.Join(dir, "poster.png")
	photo := filepath.Join(dir, "photo.png")
	b, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=12", "-t", "2", "-c:v", "mpeg4", "-q:v", "1", video).CombinedOutput()
	if err != nil {
		t.Fatalf("video fixture: %v %s", err, b)
	}
	writeTestImage(t, poster, 800, color.RGBA{G: 100, A: 255})
	writeTestImage(t, photo, 600, color.RGBA{R: 100, A: 255})
	it := mediaItem{Shortcode: strp("MIXED"), Type: strp("carousel"), MediaOwnershipVersion: 1, CarouselMedia: []carouselItem{{MediaURL: strp("https://cdn.test/clip.mp4"), ThumbnailURL: strp("https://cdn.test/poster.png")}, {MediaURL: strp("https://cdn.test/photo.png")}}}
	got, err := selectPostMedia(it, map[string][]string{"/clip.mp4": {video}, "/poster.png": {poster}, "/photo.png": {photo}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Path != video || got[1].Path != photo {
		t.Fatalf("mixed carousel=%+v", got)
	}
}

func TestSelectPostMedia(t *testing.T) {
	dir := t.TempDir()
	a, b, stray := filepath.Join(dir, "a.png"), filepath.Join(dir, "b.png"), filepath.Join(dir, "stray.png")
	writeTestImage(t, a, 500, color.RGBA{R: 100, A: 255})
	writeTestImage(t, b, 600, color.RGBA{B: 100, A: 255})
	writeTestImage(t, stray, 800, color.RGBA{G: 100, A: 255})
	index := map[string][]string{"/a.png": {a}, "/b.png": {b}, "/stray.png": {stray}}
	it := mediaItem{Shortcode: strp("POST"), Type: strp("carousel"), MediaOwnershipVersion: 1, CarouselMedia: []carouselItem{
		{MediaURL: strp("https://cdn.test/a.png?token=one"), ThumbnailURL: strp("https://cdn.test/a.png?token=two")},
		{MediaURL: strp("https://cdn.test/b.png")},
		{MediaURL: strp("https://cdn.test/a.png?token=three")},
	}}
	got, err := selectPostMedia(it, index)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Path != a || got[1].Path != b {
		t.Fatalf("carousel selection = %+v", got)
	}
	delete(index, "/a.png")
	if _, err := selectPostMedia(it, index); err == nil {
		t.Fatal("missing owned slide must fail, not substitute another image")
	}
}

func TestArchiveSuperseded(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "unique")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"keep.png", "old.png", "user.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	old, _ := json.Marshal(outManifest{Files: []fileEntry{{Dest: filepath.Join(dir, "old.png")}, {Dest: filepath.Join(dir, "keep.png")}}})
	if err := archiveSuperseded(dir, old, map[string]bool{"keep.png": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old.png")); !os.IsNotExist(err) {
		t.Fatal("superseded file still active")
	}
	for _, name := range []string{"keep.png", "user.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	archived, _ := filepath.Glob(dir + "-archive/*/old.png")
	if len(archived) != 1 {
		t.Fatalf("archive=%v", archived)
	}
	b, _ := os.ReadFile(archived[0])
	if string(b) != "old.png" {
		t.Fatal("archive changed content")
	}
}

func TestSavedScrapeOwnership(t *testing.T) {
	if os.Getenv("IGUNIQUE_SAVED_SCRAPE_TEST") != "1" {
		t.Skip("saved scrape diagnostic")
	}
	root := filepath.Join("..", "..")
	for _, handle := range []string{"realtechniques_middleeast", "revlonmiddleeast", "eco_toolsgcc"} {
		b, err := os.ReadFile(filepath.Join(root, "data", "profiles", handle+"-profile.json"))
		if err != nil {
			t.Fatal(err)
		}
		var profile profileJSON
		if err = json.Unmarshal(b, &profile); err != nil {
			t.Fatal(err)
		}
		// Manifests hold repo-relative paths. Resolve while retaining the read-only selection path.
		prior, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if err = os.Chdir(root); err != nil {
			t.Fatal(err)
		}
		index, err := readMediaIndex(filepath.Join("data", "media", handle))
		if err != nil {
			os.Chdir(prior)
			t.Fatal(err)
		}
		hashes := map[string]bool{}
		for _, post := range profile.Posts[:min(6, len(profile.Posts))] {
			selected, e := selectPostMedia(post, index)
			if e != nil {
				os.Chdir(prior)
				t.Fatal(e)
			}
			for _, f := range selected {
				hashes[f.SHA] = true
			}
		}
		os.Chdir(prior)
		t.Logf("%s: first six posts have %d distinct owned images", handle, len(hashes))
		if len(hashes) < 2 {
			t.Errorf("%s still collapses distinct posts to one image", handle)
		}
	}
}
