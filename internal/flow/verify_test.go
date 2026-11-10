package flow

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeProfile(t *testing.T, dir, handle, body string) string {
	t.Helper()
	path := filepath.Join(dir, "data", "profiles", handle+"-profile.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func goodProfile(handle string) string {
	return `{
  "ok": true,
  "username": "` + handle + `",
  "partial": false,
  "notes": ["fixture scrape"],
  "session": {"didLogin": true},
  "posts": [
    {"type": "image", "shortcode": "aaa", "permalink": "https://www.instagram.com/p/aaa/", "mediaUrls": ["https://cdn.example/a.jpg"], "thumbnailUrl": "https://cdn.example/t.jpg"},
    {"type": "carousel", "shortcode": "bbb", "permalink": "https://www.instagram.com/p/bbb/", "mediaUrls": ["https://cdn.example/b.jpg"]}
  ],
  "reels": []
}`
}

func TestVerifyProfile_Good(t *testing.T) {
	dir := t.TempDir()
	path := writeProfile(t, dir, "gooduser", goodProfile("gooduser"))
	sum, err := hashFileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifyProfile(context.Background(), VerifyInput{Path: path, Handle: "gooduser", SHA256: sum})
	if err != nil {
		t.Fatalf("VerifyProfile: %v", err)
	}
	if !got.Real || !got.OK || got.Items != 2 || got.EmptyMedia != 0 {
		t.Fatalf("result = %+v", got)
	}
	if got.Evidence == "" {
		t.Fatal("empty evidence")
	}
}

func TestVerifyProfile_SessionAuthentication(t *testing.T) {
	cases := []struct {
		name    string
		session string
		wantOK  bool
	}{
		{"saved-cookies", `{"didLogin": false}`, true},
		{"fresh-login", `{"didLogin": true}`, true},
		{"explicit-authenticated", `{"authenticated": true, "didLogin": false}`, true},
		{"explicit-unauthenticated", `{"authenticated": false, "didLogin": true}`, false},
		{"missing-evidence", `{}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body := strings.Replace(goodProfile("sessionuser"), `{"didLogin": true}`, c.session, 1)
			path := writeProfile(t, t.TempDir(), "sessionuser", body)
			got, err := VerifyProfile(context.Background(), VerifyInput{Path: path, Handle: "sessionuser"})
			if (err == nil && got.OK && got.Real) != c.wantOK {
				t.Fatalf("want authenticated=%v, result=%+v err=%v", c.wantOK, got, err)
			}
		})
	}
}

func TestVerifyProfile_PriorNotesIgnored(t *testing.T) {
	dir := t.TempDir()
	body := strings.Replace(
		goodProfile("prioruser"),
		`"notes": ["fixture scrape"]`,
		`"notes": ["[prior] force-login failed (continuing public)", "skip-reels: posts only"]`,
		1,
	)
	path := writeProfile(t, dir, "prioruser", body)
	got, err := VerifyProfile(context.Background(), VerifyInput{Path: path, Handle: "prioruser"})
	if err != nil {
		t.Fatalf("prior notes should not fail verify: %v", err)
	}
	if !got.OK || !got.Real {
		t.Fatalf("result = %+v", got)
	}
}

func TestVerifyProfile_Table(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		handle  string
		body    string
		skip    bool
		sha     string
		wantSub string
	}{
		{
			name:    "wrong-username",
			handle:  "wanted",
			body:    goodProfile("other"),
			wantSub: "username",
		},
		{
			name:    "partial",
			handle:  "partuser",
			body:    strings.Replace(goodProfile("partuser"), `"partial": false`, `"partial": true`, 1),
			wantSub: "partial",
		},
		{
			name:   "too-many-empty-media",
			handle: "emptyuser",
			body: `{
  "ok": true, "username": "emptyuser", "partial": false,
  "notes": ["x"], "session": {"didLogin": true},
  "posts": [
    {"type": "image", "shortcode": "a"},
    {"type": "image", "shortcode": "b"},
    {"type": "image", "shortcode": "c"},
    {"type": "image", "shortcode": "d"}
  ],
  "reels": []
}`,
			wantSub: "empty media",
		},
		{
			name:   "reels-with-skipReels",
			handle: "reeluser",
			skip:   true,
			body: `{
  "ok": true, "username": "reeluser", "partial": false,
  "notes": ["x"], "session": {"didLogin": true},
  "posts": [{"type": "image", "shortcode": "a", "mediaUrls": ["https://cdn.example/a.jpg"]}],
  "reels": [{"type": "reel", "shortcode": "r", "permalink": "https://www.instagram.com/reel/r/", "mediaUrls": ["https://cdn.example/r.mp4"]}]
}`,
			wantSub: "skipReels",
		},
		{
			name:    "continuing-public",
			handle:  "pubuser",
			body:    strings.Replace(goodProfile("pubuser"), "fixture scrape", "force-login failed (continuing public)", 1),
			wantSub: "fallback",
		},
		{
			name:   "missing-didLogin",
			handle: "nosesuser",
			body: `{
  "ok": true, "username": "nosesuser", "partial": false,
  "notes": ["x"], "session": {},
  "posts": [{"type": "image", "shortcode": "a", "mediaUrls": ["https://cdn.example/a.jpg"]}],
  "reels": []
}`,
			wantSub: "didLogin",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := writeProfile(t, dir, c.handle, c.body)
			sha := c.sha
			if sha == "mismatch" {
				sha = "deadbeef"
			}
			_, err := VerifyProfile(context.Background(), VerifyInput{
				Path: path, Handle: c.handle, SkipReels: c.skip, SHA256: sha,
			})
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(c.wantSub)) {
				t.Fatalf("error %q missing %q", err.Error(), c.wantSub)
			}
		})
	}
}

func TestVerifyProfile_SHAMismatch(t *testing.T) {
	dir := t.TempDir()
	path := writeProfile(t, dir, "shauser", goodProfile("shauser"))
	_, err := VerifyProfile(context.Background(), VerifyInput{
		Path: path, Handle: "shauser", SHA256: "aaa",
	})
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("want sha256 error, got %v", err)
	}
}

func TestVerifyProfile_PathMustContainHandle(t *testing.T) {
	_, err := VerifyProfile(context.Background(), VerifyInput{
		Path: "/tmp/other.json", Handle: "x",
	})
	if err == nil || !strings.Contains(err.Error(), "data/profiles") {
		t.Fatalf("got %v", err)
	}
}

func TestIsReelOrVideoPost(t *testing.T) {
	v := true
	cases := []struct {
		it   profileItem
		want bool
	}{
		{profileItem{Type: "image"}, false},
		{profileItem{Type: "carousel", IsVideo: &v}, false},
		{profileItem{Type: "photo"}, false},
		{profileItem{Type: "reel"}, true},
		{profileItem{Type: "video"}, true},
		{profileItem{Permalink: "https://www.instagram.com/x/reel/ABC/"}, true},
		{profileItem{IsVideo: &v}, true},
	}
	for _, c := range cases {
		if got := isReelOrVideoPost(c.it); got != c.want {
			t.Errorf("isReelOrVideoPost(%+v)=%v want %v", c.it, got, c.want)
		}
	}
}

func TestRequireMediaTools_MissingFFmpeg(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	err := requireMediaTools()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "ffmpeg") {
		t.Fatalf("error %q missing ffmpeg", err.Error())
	}
	var cli *CLIError
	if !asCLI(err, &cli) || cli.Retryable {
		t.Fatalf("want non-retryable CLIError, got %v", err)
	}
}

func asCLI(err error, dest **CLIError) bool {
	if err == nil {
		return false
	}
	e, ok := err.(*CLIError)
	if !ok {
		return false
	}
	*dest = e
	return true
}

func TestReadDownloadManifest_SuccessRule(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(path, []byte(`{"username":"h","outDir":"`+dir+`","total":4,"ok":3,"skipped":1,"failed":0}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readDownloadManifest(dir, 4)
	if err != nil {
		t.Fatal(err)
	}
	if got.Downloaded != 3 || got.Skipped != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestReadAnalyzeFile_LLMFailClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "analysis.json"), []byte(`{"username":"h","ok":0,"failed":2,"skipped":0,"total":2,"items":[{"status":"error","error":"2056 quota"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := readAnalyzeFile(dir)
	if err == nil {
		t.Fatal("expected llm error")
	}
	var cli *CLIError
	if !asCLI(err, &cli) || cli.Code != "llm" || cli.Retryable {
		t.Fatalf("want llm CLIError, got %v", err)
	}
}

func TestScrapeArgv_FreshVsResume(t *testing.T) {
	in := defaultInput("h")
	got := strings.Join(scrapeArgv(in), " ")
	if !strings.Contains(got, "--resume") || strings.Contains(got, "--fresh") {
		t.Fatalf("default argv = %s", got)
	}
	in.Fresh = true
	got = strings.Join(scrapeArgv(in), " ")
	if !strings.Contains(got, "--fresh") || strings.Contains(got, "--resume") {
		t.Fatalf("fresh argv = %s", got)
	}
}
