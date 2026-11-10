package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestAnalyzeOneSendsSourceBytesAtHTTPSeam proves the request shape at the
// analyzer boundary only. The local server returns canned JSON; it deliberately
// makes no claim that an upstream provider understood the visual content.
func TestAnalyzeOneSendsSourceBytesAtHTTPSeam(t *testing.T) {
	type capturedRequest struct {
		contentType string
		dataURL     string
		fps         any
	}
	captured := make(chan capturedRequest, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("authorization header = %q", got)
		}
		var payload struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if len(payload.Messages) != 2 {
			t.Errorf("unexpected message shape")
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var content []json.RawMessage
		if err := json.Unmarshal(payload.Messages[1].Content, &content); err != nil || len(content) != 2 {
			t.Errorf("unexpected user content shape: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var part struct {
			Type     string `json:"type"`
			ImageURL *struct {
				URL string `json:"url"`
			} `json:"image_url"`
			VideoURL *struct {
				URL string `json:"url"`
			} `json:"video_url"`
			FPS any `json:"fps"`
		}
		if err := json.Unmarshal(content[1], &part); err != nil {
			t.Errorf("decode media part: %v", err)
		}
		dataURL := ""
		if part.ImageURL != nil {
			dataURL = part.ImageURL.URL
		}
		if part.VideoURL != nil {
			dataURL = part.VideoURL.URL
		}
		captured <- capturedRequest{contentType: part.Type, dataURL: dataURL, fps: part.FPS}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"canned\"}"}}]}`))
	}))
	defer server.Close()

	cases := []struct {
		name, filename, mediaType, wantPart, wantPrefix string
		bytes                                           []byte
		wantFPS                                         bool
	}{
		{"image", "visual.jpg", "image", "image_url", "data:image/jpeg;base64,", []byte("image bytes with a visual-only marker"), false},
		{"video", "motion.mp4", "video", "video_url", "data:video/mp4;base64,", []byte("video bytes with a motion-only marker"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.filename)
			if err := os.WriteFile(path, tc.bytes, 0o644); err != nil {
				t.Fatal(err)
			}
			result := analyzeOne(server.Client(), "test-key", server.URL, "test-model", job{
				ID: tc.name, Kind: "post", LocalPath: path, MediaType: tc.mediaType,
				Caption: "caption deliberately does not contain the fixture marker",
			})
			if result.Status != "ok" {
				t.Fatalf("analyzeOne status=%s error=%q", result.Status, result.Error)
			}
			got := <-captured
			if got.contentType != tc.wantPart || !strings.HasPrefix(got.dataURL, tc.wantPrefix) {
				t.Fatalf("media part type=%q data URL prefix=%q", got.contentType, truncate(got.dataURL, 32))
			}
			if tc.wantFPS && got.fps != float64(1) {
				t.Fatalf("video fps=%v, want 1", got.fps)
			}
			encoded := strings.TrimPrefix(got.dataURL, tc.wantPrefix)
			gotBytes, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatalf("decode captured data URL: %v", err)
			}
			if sha256.Sum256(gotBytes) != sha256.Sum256(tc.bytes) {
				t.Fatal("captured payload bytes do not match the source fixture")
			}
		})
	}
}

func TestAnalyzeOneFallsBackOnlyForRejectedShortVideo(t *testing.T) {
	for _, tool := range []string{"ffprobe", "ffmpeg"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	video := filepath.Join(t.TempDir(), "short.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error",
		"-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=0.2",
		"-f", "lavfi", "-i", "color=c=green:s=64x64:r=10:d=0.2",
		"-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=0.2",
		"-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", video)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create short video: %v: %s", err, output)
	}
	before, err := os.ReadFile(video)
	if err != nil {
		t.Fatal(err)
	}
	beforeSHA := sha256.Sum256(before)
	type part struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL *struct {
			URL string `json:"url"`
		} `json:"image_url"`
		VideoURL *struct {
			URL string `json:"url"`
		} `json:"video_url"`
	}
	requests := make(chan []part, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Messages) != 2 {
			t.Errorf("decode request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var content []part
		if err := json.Unmarshal(payload.Messages[1].Content, &content); err != nil {
			t.Errorf("decode content: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		requests <- content
		if len(content) == 2 && content[1].Type == "video_url" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"The video modality input does not meet the requirements because: The video file is too short."}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"sampled frames\"}"}}]}`))
	}))
	defer server.Close()
	j := job{ID: "short-video", Kind: "reel", LocalPath: video, MediaType: "video", Shortcode: "short-video"}
	result := analyzeOne(server.Client(), "test-key", server.URL, "test-model", j)
	if result.Status != "ok" || result.MediaType != "video" || result.AnalysisMethod != sampledFramesMethod ||
		result.MethodVersion != sampledFramesVersion || result.FrameCount != 3 || !strings.Contains(result.Limitations, "audio") {
		t.Fatalf("sampled video result=%+v", result)
	}
	if got := sha256.Sum256(mustReadFile(t, video)); got != beforeSHA {
		t.Fatal("fallback modified the original video")
	}
	if len(requests) != 2 {
		t.Fatalf("provider requests=%d, want native video then frame images", len(requests))
	}
	first, second := <-requests, <-requests
	if len(first) != 2 || first[1].VideoURL == nil {
		t.Fatalf("first request did not carry native video: %+v", first)
	}
	if len(second) != 4 || second[0].Type != "text" || !strings.Contains(second[0].Text, "audio are unknown") {
		t.Fatalf("fallback request shape/prompt=%+v", second)
	}
	for i, wantDominant := range []string{"red", "green", "blue"} {
		if second[i+1].Type != "image_url" || second[i+1].ImageURL == nil {
			t.Fatalf("frame %d missing image_url", i+1)
		}
		encoded := strings.TrimPrefix(second[i+1].ImageURL.URL, "data:image/jpeg;base64,")
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		r, g, b, _ := img.At(32, 32).RGBA()
		dominant := "red"
		if g > r && g > b {
			dominant = "green"
		}
		if b > r && b > g {
			dominant = "blue"
		}
		if dominant != wantDominant {
			t.Fatalf("frame %d dominant color=%s, want %s", i+1, dominant, wantDominant)
		}
	}

	if isTooShortVideoRejection(400, []byte(`{"message":"The video file is too short."}`)) ||
		isTooShortVideoRejection(400, []byte(`{"message":"Unsupported video codec"}`)) ||
		isTooShortVideoRejection(500, []byte(`{"message":"The video modality input does not meet the requirements because: The video file is too short."}`)) {
		t.Fatal("unrecognized rejection triggered frame fallback")
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestCollectJobsRejectsVideoFragments(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable")
	}
	dir := t.TempDir()
	sc := "AbC123xy"
	fragment := filepath.Join(dir, sc+"_00_abcdef1234.mp4")
	image := filepath.Join(dir, sc+"_01_abcdef1234.jpg")
	if err := os.WriteFile(fragment, make([]byte, 700000), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image, []byte("image fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	videoURL := "https://cdn.test/clip.mp4?token=new"
	imageURL := "https://cdn.test/poster.jpg?token=new"
	writeMediaManifest(t, dir, map[string]string{videoURL: fragment, imageURL: image})
	prof := &profileJSON{Username: "example", Posts: []item{{
		MediaOwnershipVersion: 1, Shortcode: sc, Type: "carousel",
		CarouselMedia: []carouselItem{{MediaURL: strptr(videoURL), ThumbnailURL: strptr(imageURL)}},
	}}}
	for _, perShortcode := range []bool{true, false} {
		jobs, err := collectJobs(prof, dir, perShortcode, false, false)
		if err != nil || len(jobs) != 1 || jobs[0].LocalPath != image || jobs[0].MediaType != "image" {
			t.Fatalf("perShortcode=%v: want image fallback, jobs=%+v err=%v", perShortcode, jobs, err)
		}
	}
}

func TestCollectJobsPrefersPlayableSmallVideo(t *testing.T) {
	for _, tool := range []string{"ffprobe", "ffmpeg"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	dir := t.TempDir()
	sc := "AbC123xy"
	video := filepath.Join(dir, sc+"_00_abcdef1234.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=32x32:rate=1", "-t", "1", "-c:v", "libx264", video).CombinedOutput(); err != nil {
		t.Fatalf("create video: %v: %s", err, out)
	}
	poster := filepath.Join(dir, sc+"_01_abcdef1234.jpg")
	photo := filepath.Join(dir, sc+"_02_abcdef1234.jpg")
	if err := os.WriteFile(poster, []byte("poster fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(photo, []byte("photo fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	videoURL := "https://cdn.test/clip.mp4"
	posterURL := "https://cdn.test/poster.jpg"
	photoURL := "https://cdn.test/photo.jpg"
	writeMediaManifest(t, dir, map[string]string{videoURL: video, posterURL: poster, photoURL: photo})
	prof := &profileJSON{Username: "example", Posts: []item{{
		MediaOwnershipVersion: 1, Shortcode: sc, Type: "carousel",
		CarouselMedia: []carouselItem{
			{MediaURL: strptr(videoURL), ThumbnailURL: strptr(posterURL)},
			{MediaURL: strptr(photoURL)},
		},
	}}}
	jobs, err := collectJobs(prof, dir, true, false, false)
	if err != nil || len(jobs) != 1 || jobs[0].LocalPath != video || jobs[0].MediaType != "video" {
		t.Fatalf("want playable video, jobs=%+v err=%v", jobs, err)
	}
	withStills, err := collectJobs(prof, dir, true, true, false)
	if err != nil || len(withStills) != 2 || withStills[0].LocalPath != video || withStills[1].LocalPath != photo {
		t.Fatalf("want video payload plus owned carousel image, jobs=%+v err=%v", withStills, err)
	}
	all, err := collectJobs(prof, dir, false, false, false)
	if err != nil || len(all) != 2 || all[0].LocalPath != video || all[1].LocalPath != photo {
		t.Fatalf("want owned video and carousel photo, jobs=%+v err=%v", all, err)
	}
}

func TestIsReelOrVideoPost(t *testing.T) {
	yes := true
	cases := []struct {
		it   item
		want bool
	}{
		{item{Type: "image"}, false},
		{item{Type: "photo"}, false},
		{item{Type: "carousel", IsVideo: &yes}, false},
		{item{Type: "reel"}, true},
		{item{Type: "video"}, true},
		{item{Permalink: "https://www.instagram.com/u/reel/AbC/"}, true},
		{item{IsVideo: &yes}, true},
	}
	for _, c := range cases {
		if got := isReelOrVideoPost(c.it); got != c.want {
			t.Errorf("isReelOrVideoPost(%+v)=%v want %v", c.it, got, c.want)
		}
	}
}

func TestResolvePerShortcode(t *testing.T) {
	cases := []struct {
		per, all, want bool
	}{
		{true, false, true},
		{false, false, false},
		{true, true, false},
		{false, true, false},
	}
	for _, c := range cases {
		if got := resolvePerShortcode(c.per, c.all); got != c.want {
			t.Errorf("resolvePerShortcode(%v,%v)=%v want %v", c.per, c.all, got, c.want)
		}
	}
}

func TestCollectJobsAllFramesAddsEveryFile(t *testing.T) {
	dir := t.TempDir()
	sc := "AbC123xy"
	files := []string{
		sc + "_00_abcdef1234.jpg",
		sc + "_01_abcdef1234.jpg",
	}
	for _, name := range files {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	stray := filepath.Join(dir, sc+"_02_deadbeef00.jpg")
	if err := os.WriteFile(stray, []byte("larger retained unrelated payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	firstURL := "https://cdn.test/a.jpg?signature=current"
	secondURL := "https://cdn.test/b.jpg?signature=current"
	writeMediaManifest(t, dir, map[string]string{
		"https://cdn.test/a.jpg?signature=downloaded": filepath.Join(dir, files[0]),
		"https://cdn.test/b.jpg?signature=downloaded": filepath.Join(dir, files[1]),
	})
	prof := &profileJSON{
		Username: "example",
		Posts: []item{{
			MediaOwnershipVersion: 1, Shortcode: sc, Type: "carousel",
			CarouselMedia: []carouselItem{{MediaURL: strptr(firstURL)}, {MediaURL: strptr(secondURL)}},
		}},
	}

	one, err := collectJobs(prof, dir, true, false, false)
	if err != nil {
		t.Fatal(err)
	}
	all, err := collectJobs(prof, dir, false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 {
		t.Fatalf("per-shortcode jobs=%d want 1", len(one))
	}
	if len(all) != 2 {
		t.Fatalf("all-frames jobs=%d want 2 owned carousel assets, jobs=%+v", len(all), all)
	}
	for _, got := range all {
		if got.LocalPath == stray {
			t.Fatal("retained unowned file entered analysis")
		}
	}
}

func TestCacheMatchesCurrentAnalysisInput(t *testing.T) {
	j := job{
		ID: "POST", Kind: "post", LocalPath: "/media/POST/a.jpg", MediaType: "image",
		Caption: "current caption", Permalink: "https://www.instagram.com/p/POST/",
		Shortcode: "POST", SourceSHA: strings.Repeat("a", 64),
	}
	prior := analysisResult{ID: j.ID, Status: "ok", InputHash: analysisInputHash(j, "current-model", "https://provider.test/v1")}
	if !cacheMatches(prior, j, "current-model", "https://provider.test/v1") {
		t.Fatal("matching analyzed input should resume")
	}
	fallback := prior
	fallback.AnalysisMethod = sampledFramesMethod
	fallback.MethodVersion = sampledFramesVersion
	if !cacheMatches(fallback, j, "current-model", "https://provider.test/v1") {
		t.Fatal("current sampled-frame result should resume")
	}
	fallback.MethodVersion = 0
	if cacheMatches(fallback, j, "current-model", "https://provider.test/v1") {
		t.Fatal("obsolete sampled-frame method should be reanalyzed")
	}
	changedMedia := j
	changedMedia.SourceSHA = strings.Repeat("b", 64)
	if cacheMatches(prior, changedMedia, "current-model", "https://provider.test/v1") {
		t.Fatal("changed selected media should invalidate cache")
	}
	changedCaption := j
	changedCaption.Caption = "updated caption"
	if cacheMatches(prior, changedCaption, "current-model", "https://provider.test/v1") {
		t.Fatal("changed prompt metadata should invalidate cache")
	}
	if cacheMatches(prior, j, "new-model", "https://provider.test/v1") {
		t.Fatal("changed model should invalidate cache")
	}
	if cacheMatches(prior, j, "current-model", "https://other-provider.test/v1") {
		t.Fatal("changed provider should invalidate cache")
	}
	if cacheMatches(analysisResult{ID: j.ID, Status: "ok"}, j, "current-model", "https://provider.test/v1") {
		t.Fatal("legacy result without an input hash should be reanalyzed")
	}
}

func TestRunPoolCheckpointsBeforeAllJobsFinish(t *testing.T) {
	var requests atomic.Int32
	secondReply := make(chan struct{})
	var release sync.Once
	releaseSecond := func() { release.Do(func() { close(secondReply) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 2 {
			<-secondReply
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"canned\"}"}}]}`))
	}))
	defer server.Close()
	defer releaseSecond()

	dir := t.TempDir()
	jobs := make([]job, 2)
	for i, id := range []string{"first", "second"} {
		path := filepath.Join(dir, id+".jpg")
		if err := os.WriteFile(path, []byte(id), 0o644); err != nil {
			t.Fatal(err)
		}
		jobs[i] = job{ID: id, Kind: "post", LocalPath: path, MediaType: "image"}
	}
	outDir := filepath.Join(dir, "analysis")
	type poolOutcome struct {
		results []analysisResult
		err     error
	}
	done := make(chan poolOutcome, 1)
	go func() {
		results, err := runPool(server.Client(), "test-key", server.URL, "test-model", outDir, jobs, 1)
		done <- poolOutcome{results, err}
	}()

	firstPath := filepath.Join(outDir, "items", "first.json")
	deadline := time.Now().Add(3 * time.Second)
	for {
		if raw, err := os.ReadFile(firstPath); err == nil {
			var result analysisResult
			if err := json.Unmarshal(raw, &result); err != nil || result.Status != "ok" {
				t.Fatalf("first checkpoint invalid: result=%+v err=%v", result, err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first result was not checkpointed while second job was pending")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case <-done:
		t.Fatal("pool completed before the blocked second job")
	default:
	}
	releaseSecond()
	select {
	case outcome := <-done:
		if outcome.err != nil || len(outcome.results) != 2 {
			t.Fatalf("runPool results=%d err=%v", len(outcome.results), outcome.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pool did not finish after second response")
	}
	if _, err := os.Stat(filepath.Join(outDir, "items", "second.json")); err != nil {
		t.Fatalf("second checkpoint: %v", err)
	}
}

func TestRunPoolReportsCheckpointFailure(t *testing.T) {
	dir := t.TempDir()
	missing := job{ID: "failed", LocalPath: filepath.Join(dir, "missing.jpg"), MediaType: "image"}
	goodDir := filepath.Join(dir, "analysis")
	results, err := runPool(nil, "", "", "test-model", goodDir, []job{missing}, 1)
	if err != nil || len(results) != 1 || results[0].Status != "error" {
		t.Fatalf("failed analysis checkpoint: results=%+v err=%v", results, err)
	}
	raw, err := os.ReadFile(filepath.Join(goodDir, "items", "failed.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved analysisResult
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Status != "error" {
		t.Fatalf("saved failure checkpoint: result=%+v err=%v", saved, err)
	}

	blocked := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	results, err = runPool(nil, "", "", "test-model", blocked, []job{missing}, 1)
	if err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("checkpoint error = %v, want visible item error", err)
	}
	if len(results) != 1 || results[0].Status != "error" {
		t.Fatalf("failed analysis result not collected: %+v", results)
	}
}

func TestRunPoolStopsUndispatchedJobsAfterCheckpointFailure(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"canned\"}"}}]}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	blocked := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	jobs := make([]job, 5)
	for i := range jobs {
		id := string(rune('a' + i))
		path := filepath.Join(dir, id+".jpg")
		if err := os.WriteFile(path, []byte(id), 0o644); err != nil {
			t.Fatal(err)
		}
		jobs[i] = job{ID: id, Kind: "post", LocalPath: path, MediaType: "image"}
	}
	results, err := runPool(server.Client(), "test-key", server.URL, "test-model", blocked, jobs, 1)
	if err == nil {
		t.Fatal("checkpoint failure was not returned")
	}
	if got := requests.Load(); got > 2 {
		t.Fatalf("provider received %d requests after first checkpoint failure, want at most 2 in flight", got)
	}
	if len(results) != int(requests.Load()) {
		t.Fatalf("collected %d results for %d provider requests", len(results), requests.Load())
	}
}

func TestAnalyzeOneClassifiesOnlyPermanentProviderFailures(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "image.jpg")
	if err := os.WriteFile(path, []byte("image bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	j := job{ID: "image", Kind: "post", LocalPath: path, MediaType: "image"}
	cases := []struct {
		name, body, wantKind string
		status, wantCalls    int
	}{
		{"unauthorized", `{"error":{"message":"bad key"}}`, "auth", 401, 1},
		{"forbidden", `{"error":{"message":"key rejected"}}`, "auth", 403, 1},
		{"quota", `{"error":{"code":"QuotaExceeded","message":"Token plan usage limit exhausted"}}`, "quota", 429, 4},
		{"quota code", `{"error":{"code": 2056}}`, "quota", 429, 4},
		{"insufficient quota", `{"error":{"code":"InsufficientQuota"}}`, "quota", 429, 4},
		{"rate limit", `{"error":{"code":"RateLimitExceeded","message":"Too many requests"}}`, "", 429, 4},
		{"per-minute quota", `{"error":{"message":"Requests per minute quota exceeded"}}`, "", 429, 4},
		{"bad image", `{"error":{"message":"unsupported image"}}`, "", 400, 1},
		{"transient server", `{"error":{"message":"temporary failure"}}`, "", 503, 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			result := analyzeOneWithRetry(server.Client(), "test-key", server.URL, "test-model", j, func(time.Duration) {})
			if result.ProviderFailure != tc.wantKind || result.ProviderStatus != tc.status || result.Status != "error" {
				t.Fatalf("result=%+v, want provider kind %q/status %d", result, tc.wantKind, tc.status)
			}
			if got := int(calls.Load()); got != tc.wantCalls {
				t.Fatalf("provider calls=%d, want %d", got, tc.wantCalls)
			}
		})
	}
}

func TestRunPoolStopsOnPermanentProviderFailure(t *testing.T) {
	cases := []struct {
		name, body, kind    string
		status, callsPerJob int
	}{
		{"unauthorized", `{"error":{"message":"key rejected"}}`, "auth", 401, 1},
		{"forbidden", `{"error":{"message":"key rejected"}}`, "auth", 403, 1},
		{"quota exhausted", `{"error":{"code":"QuotaExceeded","message":"Token plan usage limit exhausted"}}`, "quota", 429, 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			dir := t.TempDir()
			jobs := make([]job, 5)
			for i := range jobs {
				id := string(rune('a' + i))
				path := filepath.Join(dir, id+".jpg")
				if err := os.WriteFile(path, []byte(id), 0o644); err != nil {
					t.Fatal(err)
				}
				jobs[i] = job{ID: id, Kind: "post", LocalPath: path, MediaType: "image"}
			}
			outDir := filepath.Join(dir, "analysis")
			results, err := runPoolWithRetryWait(server.Client(), "test-key", server.URL, "test-model", outDir, jobs, 1, func(time.Duration) {})
			var providerErr *providerFailureError
			if !errors.As(err, &providerErr) || providerErr.Kind != tc.kind || providerErr.Status != tc.status {
				t.Fatalf("pool error=%v, want %s HTTP %d", err, tc.kind, tc.status)
			}
			if got := int(requests.Load()); got > 2*tc.callsPerJob {
				t.Fatalf("provider received %d requests after permanent failure, want at most 2 jobs in flight", got)
			}
			if len(results)*tc.callsPerJob != int(requests.Load()) {
				t.Fatalf("collected %d results for %d requests", len(results), requests.Load())
			}
			if _, err := os.Stat(filepath.Join(outDir, "items", "a.json")); err != nil {
				t.Fatalf("provider failure checkpoint: %v", err)
			}
		})
	}
}

func TestLoadPriorOKPrefersCheckpointOverOldAggregate(t *testing.T) {
	dir := t.TempDir()
	old := analysisResult{ID: "post", Status: "ok", InputHash: "old"}
	if err := writeJSON(filepath.Join(dir, "analysis.json"), map[string]any{"items": []analysisResult{old}}); err != nil {
		t.Fatal(err)
	}
	current := analysisResult{ID: "post", Status: "ok", InputHash: "current"}
	if err := writeItemJSON(dir, current); err != nil {
		t.Fatal(err)
	}
	if got := loadPriorOK(dir)["post"].InputHash; got != "current" {
		t.Fatalf("resumed input hash = %q, want current checkpoint", got)
	}
}

func writeMediaManifest(t *testing.T, dir string, entries map[string]string) {
	t.Helper()
	results := make([]map[string]any, 0, len(entries))
	byURL := make(map[string]string, len(entries))
	for rawURL, local := range entries {
		results = append(results, map[string]any{"url": rawURL, "localPath": local, "status": "ok"})
		byURL[rawURL] = local
	}
	if err := writeJSON(filepath.Join(dir, "manifest.json"), map[string]any{"results": results, "byUrl": byURL}); err != nil {
		t.Fatal(err)
	}
}

func strptr(value string) *string { return &value }
