package igdl

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func strp(s string) *string { return &s }

func TestIsReelOrVideoItem(t *testing.T) {
	if IsReelOrVideoItem(MediaItem{Type: strp("image")}) {
		t.Fatal("image should be kept")
	}
	if IsReelOrVideoItem(MediaItem{Type: strp("carousel")}) {
		t.Fatal("carousel should be kept")
	}
	yes := true
	if IsReelOrVideoItem(MediaItem{Type: strp("carousel"), IsVideo: &yes}) {
		t.Fatal("carousel with video slides should be kept")
	}
	if !IsReelOrVideoItem(MediaItem{Type: strp("reel")}) {
		t.Fatal("reel type should skip")
	}
	if !IsReelOrVideoItem(MediaItem{Type: strp("video")}) {
		t.Fatal("video type should skip")
	}
	if !IsReelOrVideoItem(MediaItem{Permalink: strp("https://www.instagram.com/x/reel/ABC/")}) {
		t.Fatal("reel permalink should skip")
	}
}

func TestCollectJobsSkipReels(t *testing.T) {
	img := "https://cdn.example/a.jpg"
	vid := "https://cdn.example/b.mp4"
	car := "https://cdn.example/c.jpg"
	p := ProfileJSON{
		Username: "x",
		Posts: []MediaItem{
			{Shortcode: strp("AAA"), Type: strp("image"), MediaURLs: []string{img}},
			{Shortcode: strp("BBB"), Type: strp("video"), MediaURLs: []string{vid}},
			{Shortcode: strp("CCC"), Type: strp("carousel"), MediaURLs: []string{car}},
		},
		Reels: []MediaItem{
			{Shortcode: strp("DDD"), Type: strp("reel"), MediaURLs: []string{"https://cdn.example/d.mp4"}},
		},
	}
	got := CollectJobs(&p, true)
	urls := map[string]bool{}
	for _, j := range got {
		urls[j.URL] = true
		if j.Kind == "reel" {
			t.Fatalf("skip-reels still collected reel job %+v", j)
		}
	}
	if !urls[img] || !urls[car] {
		t.Fatalf("skip-reels missing image/carousel: %+v", urls)
	}
	if urls[vid] || urls["https://cdn.example/d.mp4"] {
		t.Fatalf("skip-reels collected a video/reel URL: %+v", urls)
	}
}

func TestDestRelPath(t *testing.T) {
	got := DestRelPath("DWbzgg1CEc1", 4, "13d6451fe1", ".jpg")
	want := filepath.Join("DWbzgg1CEc1", "DWbzgg1CEc1_04_13d6451fe1.jpg")
	if got != want {
		t.Fatalf("DestRelPath = %q, want %q", got, want)
	}
}

func TestShortcodeFromFilename(t *testing.T) {
	cases := map[string]string{
		"DWbzgg1CEc1_00_216c120303.mp4": "DWbzgg1CEc1",
		"profile_00_93d9c08736.jpg":     "profile",
		"DafszAlNQV__00_abc123def0.mp4": "DafszAlNQV_",
	}
	for in, want := range cases {
		if got := shortcodeFromFilename(in); got != want {
			t.Errorf("shortcodeFromFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNestPath(t *testing.T) {
	flat := "data/media/raye.psd_/DWZpkyeiIfB_00_be9de8789b.jpg"
	want := filepath.Join("data/media/raye.psd_", "DWZpkyeiIfB", "DWZpkyeiIfB_00_be9de8789b.jpg")
	if got := nestPath(flat); got != want {
		t.Fatalf("nestPath(flat) = %q, want %q", got, want)
	}
	if got := nestPath(want); got != want {
		t.Fatalf("nestPath is not idempotent: %q", got)
	}
}

func TestReorganizeOutDir(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "ABC123_00_aaaaaaaaaa.jpg")
	b := filepath.Join(dir, "ABC123_01_bbbbbbbbbb.jpg")
	c := filepath.Join(dir, "DEF456_00_cccccccccc.mp4")
	mustWrite(t, a, "a")
	mustWrite(t, b, "bb")
	mustWrite(t, c, "ccc")

	man := Manifest{
		Username: "t",
		OutDir:   dir,
		Results: []Result{
			{URL: "https://x/a", Local: a, Status: "ok", Filename: filepath.Base(a)},
			{URL: "https://x/b", Local: b, Status: "ok", Filename: filepath.Base(b)},
			{URL: "https://x/c", Local: c, Status: "ok", Filename: filepath.Base(c)},
		},
		ByURL: map[string]string{
			"https://x/a": a,
			"https://x/b": b,
			"https://x/c": c,
		},
	}
	raw, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	moved, err := ReorganizeOutDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 3 {
		t.Fatalf("moved = %d, want 3", moved)
	}

	wantA := filepath.Join(dir, "ABC123", "ABC123_00_aaaaaaaaaa.jpg")
	wantB := filepath.Join(dir, "ABC123", "ABC123_01_bbbbbbbbbb.jpg")
	wantC := filepath.Join(dir, "DEF456", "DEF456_00_cccccccccc.mp4")
	for _, p := range []string{wantA, wantB, wantC} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("missing %s: %v", p, err)
		}
	}
	for _, p := range []string{a, b, c} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("flat file still present: %s", p)
		}
	}

	moved2, err := ReorganizeOutDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if moved2 != 0 {
		t.Fatalf("second reorg moved %d, want 0", moved2)
	}

	raw, err = os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got Manifest
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.ByURL["https://x/a"] != wantA {
		t.Fatalf("byUrl a = %q, want %q", got.ByURL["https://x/a"], wantA)
	}
	if got.Results[2].Local != wantC {
		t.Fatalf("Results[2].Local = %q, want %q", got.Results[2].Local, wantC)
	}
}

func TestDownloadOneSkipsManifestMappedFileWithoutRequest(t *testing.T) {
	dir := t.TempDir()
	url := "https://media.example/complete.jpg"
	local := filepath.Join(dir, "post", "complete.jpg")
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, local, "complete")
	if _, err := WriteManifest(dir, "user", 1, []Result{{
		URL: url, Local: local, Status: "ok", Filename: filepath.Base(local), Bytes: 8,
	}}, time.Unix(0, 0), time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	got := DownloadOne(server.Client(), dir, Job{URL: url, Shortcode: "post"})
	if got.Status != "skipped" || got.Local != local || got.Bytes != 8 {
		t.Fatalf("DownloadOne result = %+v, want skipped completed file", got)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want 0", requests)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
