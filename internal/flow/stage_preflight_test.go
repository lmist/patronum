package flow

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// ---------- helpers ----------

// createFixtureCookieDB builds a minimal Chrome Cookies SQLite database in
// dir. Rows slice contains (host_key, name, expires_utc) triples.
func createFixtureCookieDB(t *testing.T, dir string, rows []cookieFixture) string {
	t.Helper()
	dbPath := filepath.Join(dir, "Cookies")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open fixture db: %v", err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS cookies (
		host_key TEXT NOT NULL,
		name TEXT NOT NULL,
		expires_utc INTEGER NOT NULL,
		value BLOB DEFAULT '',
		encrypted_value BLOB DEFAULT ''
	)`)
	if err != nil {
		t.Fatalf("create table: %v", err)
	}
	for _, r := range rows {
		_, err := db.Exec("INSERT INTO cookies (host_key, name, expires_utc) VALUES (?, ?, ?)",
			r.hostKey, r.name, r.expiresUtc)
		if err != nil {
			t.Fatalf("insert cookie: %v", err)
		}
	}
	return dbPath
}

type cookieFixture struct {
	hostKey    string
	name       string
	expiresUtc int64
}

// futureChrome returns a Chrome expires_utc 24 hours in the future.
func futureChrome() int64 {
	return time.Now().Add(24*time.Hour).UnixMicro() + windowsEpochOffsetMicros
}

// pastChrome returns a Chrome expires_utc 24 hours in the past.
func pastChrome() int64 {
	return time.Now().Add(-24*time.Hour).UnixMicro() + windowsEpochOffsetMicros
}

// ---------- chromeCookieExpiry ----------

func TestChromeCookieExpiry_ValidTimestamp(t *testing.T) {
	// 2030-01-01 00:00:00 UTC → Chrome microseconds since 1601.
	target := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	chromeTs := target.UnixMicro() + windowsEpochOffsetMicros
	got := chromeCookieExpiry(chromeTs)
	diff := got.Sub(target)
	if diff < -time.Second || diff > time.Second {
		t.Fatalf("chromeCookieExpiry(%d) = %v, want ~%v (diff=%v)", chromeTs, got, target, diff)
	}
}

func TestChromeCookieExpiry_Zero(t *testing.T) {
	got := chromeCookieExpiry(0)
	if !got.IsZero() {
		t.Fatalf("chromeCookieExpiry(0) = %v, want zero", got)
	}
}

// ---------- checkEnv ----------

func TestCheckEnv_AllPresent(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "sk-test")
	vars, err := checkEnv()
	if err != nil {
		t.Fatalf("checkEnv: %v", err)
	}
	if len(vars) == 0 {
		t.Fatal("checkEnv returned empty vars")
	}
	for _, v := range vars {
		if !v.Set && v.Name == "IG_USER" {
			t.Fatalf("IG_USER should be set")
		}
	}
}

func TestCheckEnv_MissingIGUser(t *testing.T) {
	t.Setenv("IG_USER", "")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "sk-test")
	_, err := checkEnv()
	if err == nil {
		t.Fatal("expected error for missing IG_USER")
	}
	if !strings.Contains(err.Error(), "IG_USER") {
		t.Fatalf("error should mention IG_USER: %v", err)
	}
}

func TestCheckEnv_MissingAllAPIKeys(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "")
	t.Setenv("DASHSCOPE_API_KEY", "")
	t.Setenv("ALIBABA_API_KEY", "")
	_, err := checkEnv()
	if err == nil {
		t.Fatal("expected error for missing API key")
	}
	if !strings.Contains(err.Error(), "QWEN_API_KEY") {
		t.Fatalf("error should mention QWEN_API_KEY: %v", err)
	}
}

func TestCheckEnv_DashScopeKeySuffices(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "")
	t.Setenv("DASHSCOPE_API_KEY", "sk-dash")
	t.Setenv("ALIBABA_API_KEY", "")
	_, err := checkEnv()
	if err != nil {
		t.Fatalf("DASHSCOPE_API_KEY should suffice: %v", err)
	}
}

// ---------- checkCookieJar ----------

func TestCheckCookieJar_SelectedProfile(t *testing.T) {
	for _, absolute := range []bool{false, true} {
		name := "relative"
		if absolute {
			name = "absolute"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			profile := filepath.Join(root, "data", "dashboard-sessions", "selected", "profile")
			jarDir := filepath.Join(profile, "Default")
			if err := os.MkdirAll(jarDir, 0700); err != nil {
				t.Fatal(err)
			}
			createFixtureCookieDB(t, jarDir, []cookieFixture{
				{hostKey: ".instagram.com", name: "sessionid", expiresUtc: futureChrome()},
				{hostKey: ".instagram.com", name: "ds_user_id", expiresUtc: futureChrome()},
			})
			t.Setenv("IGFLOW_REPO_ROOT", root)
			configured := profile
			if !absolute {
				configured, _ = filepath.Rel(root, profile)
			}
			t.Setenv("PATRONUM_CHROME_PROFILE_DIR", configured)
			auth, err := checkCookieJar("")
			if err != nil || !auth.OK {
				t.Fatalf("selected session rejected: auth=%+v err=%v", auth, err)
			}
			// An explicit jar remains authoritative, even when a selected profile is valid.
			if _, err := checkCookieJar(filepath.Join(root, "missing-explicit-jar")); err == nil {
				t.Fatal("explicit jar was ignored")
			}
		})
	}
}

func TestCheckCookieJar_ValidCookies(t *testing.T) {
	dir := t.TempDir()
	dbPath := createFixtureCookieDB(t, dir, []cookieFixture{
		{hostKey: ".instagram.com", name: "sessionid", expiresUtc: futureChrome()},
		{hostKey: ".instagram.com", name: "ds_user_id", expiresUtc: futureChrome()},
	})
	auth, err := checkCookieJar(dbPath)
	if err != nil {
		t.Fatalf("checkCookieJar: %v", err)
	}
	if !auth.OK {
		t.Fatal("auth.OK should be true")
	}
	if auth.ExpiresAt.IsZero() {
		t.Fatal("auth.ExpiresAt should be non-zero")
	}
	if auth.ExpiresAt.Before(time.Now()) {
		t.Fatalf("auth.ExpiresAt should be in the future: %v", auth.ExpiresAt)
	}
}

func TestCheckCookieJar_MissingSessionid(t *testing.T) {
	dir := t.TempDir()
	dbPath := createFixtureCookieDB(t, dir, []cookieFixture{
		{hostKey: ".instagram.com", name: "ds_user_id", expiresUtc: futureChrome()},
	})
	_, err := checkCookieJar(dbPath)
	if err == nil {
		t.Fatal("expected error for missing sessionid")
	}
	if !strings.Contains(err.Error(), "sessionid") {
		t.Fatalf("error should mention sessionid: %v", err)
	}
}

func TestCheckCookieJar_MissingDsUserId(t *testing.T) {
	dir := t.TempDir()
	dbPath := createFixtureCookieDB(t, dir, []cookieFixture{
		{hostKey: ".instagram.com", name: "sessionid", expiresUtc: futureChrome()},
	})
	_, err := checkCookieJar(dbPath)
	if err == nil {
		t.Fatal("expected error for missing ds_user_id")
	}
	if !strings.Contains(err.Error(), "ds_user_id") {
		t.Fatalf("error should mention ds_user_id: %v", err)
	}
}

func TestCheckCookieJar_ExpiredCookies(t *testing.T) {
	dir := t.TempDir()
	dbPath := createFixtureCookieDB(t, dir, []cookieFixture{
		{hostKey: ".instagram.com", name: "sessionid", expiresUtc: pastChrome()},
		{hostKey: ".instagram.com", name: "ds_user_id", expiresUtc: pastChrome()},
	})
	_, err := checkCookieJar(dbPath)
	if err == nil {
		t.Fatal("expected error for expired cookies")
	}
	if !strings.Contains(err.Error(), "sessionid") {
		t.Fatalf("error should mention missing cookies: %v", err)
	}
}

func TestCheckCookieJar_WrongHost(t *testing.T) {
	dir := t.TempDir()
	dbPath := createFixtureCookieDB(t, dir, []cookieFixture{
		{hostKey: ".facebook.com", name: "sessionid", expiresUtc: futureChrome()},
		{hostKey: ".facebook.com", name: "ds_user_id", expiresUtc: futureChrome()},
	})
	_, err := checkCookieJar(dbPath)
	if err == nil {
		t.Fatal("expected error for wrong host_key")
	}
}

func TestCheckCookieJar_MissingFile(t *testing.T) {
	_, err := checkCookieJar(filepath.Join(t.TempDir(), "nonexistent"))
	if err == nil {
		t.Fatal("expected error for missing cookie file")
	}
}

func TestCheckCookieJar_EmptyDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := createFixtureCookieDB(t, dir, nil) // no rows
	_, err := checkCookieJar(dbPath)
	if err == nil {
		t.Fatal("expected error for empty cookie DB")
	}
}

// ---------- checkTools ----------

func TestCheckTools_BunAndGoPresent(t *testing.T) {
	// bun and go should be on PATH in CI / dev env.
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("bun not on PATH")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}
	tools, err := checkTools(true, true) // skipUnique/skipKB so optional tools are not required
	if err != nil {
		t.Fatalf("checkTools: %v", err)
	}
	bunFound := false
	goFound := false
	for _, tool := range tools {
		if tool.Name == "bun" && tool.Found {
			bunFound = true
		}
		if tool.Name == "go" && tool.Found {
			goFound = true
		}
	}
	if !bunFound {
		t.Fatal("bun should be found")
	}
	if !goFound {
		t.Fatal("go should be found")
	}
}

func TestCheckTools_MissingFfmpegRequired(t *testing.T) {
	// If ffmpeg is not on PATH AND skipUnique=false, should fail.
	if _, err := exec.LookPath("ffmpeg"); err == nil {
		// ffmpeg IS on PATH — we can't test the missing case without
		// manipulating PATH, which is fragile. Test the logic instead.
		t.Skip("ffmpeg on PATH; can't test missing-ffmpeg scenario")
	}
	_, err := checkTools(false, true) // skipUnique=false → ffmpeg required
	if err == nil {
		t.Fatal("expected error for missing ffmpeg")
	}
	if !strings.Contains(err.Error(), "ffmpeg") {
		t.Fatalf("error should mention ffmpeg: %v", err)
	}
}

func TestCheckTools_MissingFfmpegSkipUnique(t *testing.T) {
	// With skipUnique=true, missing ffmpeg should not error.
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("bun not on PATH")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}
	tools, err := checkTools(true, true)
	if err != nil {
		t.Fatalf("checkTools with skipUnique should not fail on ffmpeg: %v", err)
	}
	// ffmpeg/ffprobe should still appear as not required
	for _, tool := range tools {
		if tool.Name == "ffmpeg" && tool.Required {
			t.Fatal("ffmpeg should not be required when skipUnique=true")
		}
	}
}

func TestCheckTools_CollectionDoesNotRequireOpenKnowledge(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"bun", "go"} {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Skipf("%s not on PATH", name)
		}
		if err := os.Symlink(path, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("IGFLOW_REPO_ROOT", dir)
	tools, err := checkTools(true, false)
	if err != nil {
		t.Fatalf("collection should not require ok: %v", err)
	}
	for _, tool := range tools {
		if tool.Name == "ok" {
			t.Fatal("collection must not inspect OpenKnowledge")
		}
	}
}

// ---------- RunPreflight (composite) ----------

func TestRunPreflight_EnvMissing(t *testing.T) {
	t.Setenv("IG_USER", "")
	t.Setenv("IG_PASS", "")
	t.Setenv("QWEN_API_KEY", "")
	t.Setenv("DASHSCOPE_API_KEY", "")
	t.Setenv("ALIBABA_API_KEY", "")
	t.Setenv("IGFLOW_REPO_ROOT", t.TempDir())

	_, err := RunPreflight(context.Background(), JobInput{}, "", "")
	if err == nil {
		t.Fatal("expected error for missing env")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected CLIError, got %T: %v", err, err)
	}
	if cliErr.Retryable {
		t.Fatal("env failure should be non-retryable")
	}
	if cliErr.Code != "precondition" {
		t.Fatalf("expected code=precondition, got %q", cliErr.Code)
	}
	if !strings.Contains(cliErr.Msg, "missing env") || !strings.Contains(cliErr.Msg, ".env") {
		t.Fatalf("env failure should name missing keys and .env: %q", cliErr.Msg)
	}
}

func TestRunPreflight_LLMFails(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "sk-test")

	dir := t.TempDir()
	t.Setenv("IGFLOW_REPO_ROOT", dir)

	// Use fixture script that returns LLM failure
	absLlm, err := filepath.Abs("testdata/llm.sh")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvPreflightCmd, "bash "+absLlm)

	_, err = RunPreflight(context.Background(), JobInput{}, "test-wf", "")
	if err == nil {
		t.Fatal("expected error for LLM failure")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected CLIError, got %T: %v", err, err)
	}
	if cliErr.Retryable {
		t.Fatal("LLM failure should be non-retryable")
	}
	if cliErr.Code != "llm" {
		t.Fatalf("expected code=llm, got %q", cliErr.Code)
	}
}

func TestRunPreflight_LLMNoTailJSONDoesNotBlameEnv(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "sk-test")

	dir := t.TempDir()
	t.Setenv("IGFLOW_REPO_ROOT", dir)

	absEmpty, err := filepath.Abs("testdata/empty.sh")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvPreflightCmd, "bash "+absEmpty)

	_, err = RunPreflight(context.Background(), JobInput{}, "test-wf", "")
	if err == nil {
		t.Fatal("expected error for empty preflight output")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected CLIError, got %T: %v", err, err)
	}
	if !strings.Contains(cliErr.Msg, "no tail JSON") {
		t.Fatalf("want the real parse failure, got %q", cliErr.Msg)
	}
	if strings.Contains(cliErr.Msg, "QWEN_API_KEY") || strings.Contains(cliErr.Msg, ".env") {
		t.Fatalf("must not blame .env when the key is set: %q", cliErr.Msg)
	}
}

func TestRunPreflight_AuthMissingCookies(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "sk-test")

	dir := t.TempDir()
	t.Setenv("IGFLOW_REPO_ROOT", dir)

	// LLM succeeds
	absOk, err := filepath.Abs("testdata/ok.sh")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvPreflightCmd, "bash "+absOk)

	// Empty cookie DB
	cookieDir := filepath.Join(dir, "cookies")
	os.MkdirAll(cookieDir, 0o755)
	dbPath := createFixtureCookieDB(t, cookieDir, nil)

	_, err = RunPreflight(context.Background(), JobInput{SkipUnique: true}, "test-wf", dbPath)
	if err == nil {
		t.Fatal("expected error for missing cookies")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected CLIError, got %T: %v", err, err)
	}
	if cliErr.Code != "auth" {
		t.Fatalf("expected code=auth, got %q", cliErr.Code)
	}
	if cliErr.Retryable {
		t.Fatal("auth failure should be non-retryable")
	}
	if !strings.Contains(cliErr.Msg, "bun run login") {
		t.Fatalf("error should contain hint: %v", cliErr.Msg)
	}
}

func TestRunPreflight_HappyPath(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "sk-test")

	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("bun not on PATH")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}

	dir := t.TempDir()
	t.Setenv("IGFLOW_REPO_ROOT", dir)

	// LLM succeeds
	absOk, err := filepath.Abs("testdata/ok.sh")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvPreflightCmd, "bash "+absOk)

	// Valid cookies
	cookieDir := filepath.Join(dir, "cookies")
	os.MkdirAll(cookieDir, 0o755)
	dbPath := createFixtureCookieDB(t, cookieDir, []cookieFixture{
		{hostKey: ".instagram.com", name: "sessionid", expiresUtc: futureChrome()},
		{hostKey: ".instagram.com", name: "ds_user_id", expiresUtc: futureChrome()},
	})

	result, err := RunPreflight(context.Background(), JobInput{SkipUnique: true}, "test-wf", dbPath)
	if err != nil {
		t.Fatalf("RunPreflight: %v", err)
	}
	if !result.OK {
		t.Fatal("result.OK should be true")
	}
	if result.Auth == nil || !result.Auth.OK {
		t.Fatal("result.Auth.OK should be true")
	}
	if result.LLM == nil || !result.LLM.OK {
		t.Fatal("result.LLM.OK should be true")
	}
	if len(result.Env) == 0 {
		t.Fatal("result.Env should be non-empty")
	}
	if len(result.Tools) == 0 {
		t.Fatal("result.Tools should be non-empty")
	}
}

// ---------- error classification ----------

func TestRunPreflight_ErrorsAreNonRetryable(t *testing.T) {
	// Every failure from preflight must be non-retryable per bead spec.
	cases := []struct {
		name string
		err  error
	}{
		{"env", func() error {
			t.Setenv("IG_USER", "")
			t.Setenv("IG_PASS", "")
			t.Setenv("QWEN_API_KEY", "")
			t.Setenv("DASHSCOPE_API_KEY", "")
			t.Setenv("ALIBABA_API_KEY", "")
			t.Setenv("IGFLOW_REPO_ROOT", t.TempDir())
			_, err := RunPreflight(context.Background(), JobInput{}, "", "")
			return err
		}()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.err == nil {
				t.Skip("no error produced")
			}
			if RetryPredicate(tc.err) {
				t.Fatalf("preflight error should be non-retryable: %v", tc.err)
			}
		})
	}
}

// ---------- integration: preflight stage in ScrapeJob ----------

func TestScrapeJob_PreflightFails_ErrorEvent(t *testing.T) {
	ctx := bootTestHost(t)
	t.Cleanup(func() { SetStages(DefaultStages()) })

	fake := newFakeStages()
	// Override preflight to simulate auth failure.
	fake.fail[StagePreflight] = &CLIError{
		Stage:     StagePreflight,
		Retryable: false,
		Code:      "auth",
		Msg:       "missing cookies — " + HintAuth,
	}
	fake.install()

	in := defaultInput("preflight_test")
	in.NoPreflight = false // enable preflight
	wfID := BuildWorkflowID(in.Handle, time.Now())

	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	result, err := handle.GetResult()
	if err == nil {
		t.Fatalf("expected error, got result: %+v", result)
	}
	// The scrape stage should NOT have run.
	if fake.count(StageScrape) > 0 {
		t.Fatal("scrape should not run after preflight failure")
	}
}

func TestScrapeJob_PreflightLLMFail_ErrorEvent(t *testing.T) {
	ctx := bootTestHost(t)
	t.Cleanup(func() { SetStages(DefaultStages()) })

	fake := newFakeStages()
	fake.fail[StagePreflight] = &CLIError{
		Stage:     StagePreflight,
		Retryable: false,
		Code:      "llm",
		Msg:       "LLM preflight failed (quota) — " + HintLLM,
	}
	fake.install()

	in := defaultInput("llmfail_test")
	in.NoPreflight = false
	wfID := BuildWorkflowID(in.Handle, time.Now())

	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	_, err = handle.GetResult()
	if err == nil {
		t.Fatal("expected error from LLM preflight failure")
	}
	if fake.count(StageScrape) > 0 {
		t.Fatal("scrape should not run after LLM preflight failure")
	}
}

func TestScrapeJob_NoPreflight_SkipsPreflight(t *testing.T) {
	ctx := bootTestHost(t)
	t.Cleanup(func() { SetStages(DefaultStages()) })

	fake := newFakeStages()
	fake.install()

	in := defaultInput("nopreflight_test")
	in.NoPreflight = true
	wfID := BuildWorkflowID(in.Handle, time.Now())

	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	result, err := handle.GetResult()
	if err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	if !result.OK {
		t.Fatal("result.OK should be true")
	}
	if fake.count(StagePreflight) > 0 {
		t.Fatal("preflight should not run when NoPreflight=true")
	}
}

func TestRunPreflight_SkipLLMKeepsAuthChecks(t *testing.T) {
	t.Setenv("IG_USER", "testuser")
	t.Setenv("IG_PASS", "testpass")
	t.Setenv("QWEN_API_KEY", "dead-key")
	dir := t.TempDir()
	t.Setenv("IGFLOW_REPO_ROOT", dir)
	t.Setenv(EnvPreflightCmd, "bash "+filepath.Join(dir, "must-not-run.sh"))
	dbPath := createFixtureCookieDB(t, dir, []cookieFixture{
		{hostKey: ".instagram.com", name: "sessionid", expiresUtc: futureChrome()},
		{hostKey: ".instagram.com", name: "ds_user_id", expiresUtc: futureChrome()},
	})
	in := JobInput{SkipUnique: true, SkipLLMPreflight: true}
	result, err := RunPreflight(context.Background(), in, "skip-llm", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.LLM == nil || !result.LLM.Skipped || result.LLM.OK || result.Auth == nil || !result.Auth.OK {
		t.Fatalf("expected skipped provider with checked auth: %+v", result)
	}
	_, err = RunPreflight(context.Background(), in, "skip-llm", filepath.Join(dir, "missing-cookies"))
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "auth" {
		t.Fatalf("auth must still fail: %v", err)
	}
	if !strings.Contains(strings.Join(scrapeArgv(in), " "), "--skip-llm-preflight") {
		t.Fatal("scraper must receive skip flag")
	}
}
