package flow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fixtureCmd returns "bash <abs testdata path>" for the given fixture,
// suitable for CLISpec.Argv or an EnvOverride value.
func fixtureCmd(t *testing.T, name string) []string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	p := filepath.Join(wd, "testdata", name)
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("fixture missing: %v", err)
	}
	return []string{"bash", p}
}

// tempLog is a per-test log file under t.TempDir(). exec.go creates the
// parent dir itself, so tests need not.
func tempLog(t *testing.T, stage string) string {
	t.Helper()
	return filepath.Join(t.TempDir(), stage+".log")
}

func TestClassifyExplicitTransientJSON(t *testing.T) {
	for _, tc := range []struct {
		name string
		exit int
		kind string
		flag any
		want bool
	}{
		{"navigation", 1, "navigation timed out", true, true},
		{"unspecified", 1, "bad artifact", nil, false},
		{"string flag", 1, "navigation timed out", "true", false},
		{"usage", 2, "invalid argument", true, false},
		{"auth exit", 3, "login required", true, false},
		{"llm exit", 4, "quota", true, false},
		{"auth marker", 1, "auth", true, false},
		{"llm marker", 1, "llm", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := classify(CLIResult{Stage: "scrape", ExitCode: tc.exit, JSON: map[string]any{"ok": false, "error": tc.kind, "retryable": tc.flag}}, errors.New("exit"), nil)
			var cli *CLIError
			if !errors.As(err, &cli) || cli.Retryable != tc.want {
				t.Fatalf("got %#v, want retryable=%v", err, tc.want)
			}
		})
	}
}

func TestRunCLI_SuccessParsesTailJSON(t *testing.T) {
	log := tempLog(t, "scrape")
	res, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "ok.sh"),
		LogPath: log,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.OK() {
		t.Fatalf("expected ok=true, got %#v", res.JSON)
	}
	if got := res.String("path"); got != "data/profiles/x-profile.json" {
		t.Fatalf("path mismatch: %q", got)
	}
	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if res.Stage != "scrape" {
		t.Fatalf("stage lost: %q", res.Stage)
	}
	if !reflect.DeepEqual(res.LogPath, log) {
		t.Fatalf("log path mismatch: %q vs %q", res.LogPath, log)
	}
	// Log file must contain both stdout and stderr chatter.
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	body := string(b)
	if !strings.Contains(body, "scrape starting") {
		t.Fatalf("log missing stdout chatter: %q", body)
	}
	if !strings.Contains(body, "scrape progress halfway") {
		t.Fatalf("log missing stderr chatter: %q", body)
	}
	if !strings.Contains(body, "\"ok\":true") {
		t.Fatalf("log missing tail JSON: %q", body)
	}
}

func TestRunCLI_FailJSONIsNonRetryable(t *testing.T) {
	log := tempLog(t, "scrape")
	_, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "fail-json.sh"),
		LogPath: log,
	})
	var cli *CLIError
	if !errors.As(err, &cli) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cli.Retryable {
		t.Fatalf("expected non-retryable, got retryable")
	}
	if cli.ExitCode != 1 {
		t.Fatalf("expected exit 1, got %d", cli.ExitCode)
	}
	if RetryPredicate(err) {
		t.Fatalf("RetryPredicate should reject ok=false errors")
	}
}

func TestRunCLI_CrashNoJSONIsRetryable(t *testing.T) {
	log := tempLog(t, "scrape")
	_, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "crash.sh"),
		LogPath: log,
	})
	var cli *CLIError
	if !errors.As(err, &cli) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if !cli.Retryable {
		t.Fatalf("expected retryable, got non-retryable: %v", cli)
	}
	if !RetryPredicate(err) {
		t.Fatalf("RetryPredicate should accept crashes")
	}
	if cli.ExitCode == 0 {
		t.Fatalf("expected non-zero exit, got %d", cli.ExitCode)
	}
}

func TestRunCLI_AuthExitCodeMapsToCodeAuth(t *testing.T) {
	log := tempLog(t, "scrape")
	_, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "auth.sh"),
		LogPath: log,
	})
	var cli *CLIError
	if !errors.As(err, &cli) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cli.Code != "auth" {
		t.Fatalf("expected Code=auth, got %q", cli.Code)
	}
	if cli.Retryable {
		t.Fatalf("auth failure must be non-retryable")
	}
	if cli.ExitCode != ExitAuthFail {
		t.Fatalf("expected exit %d, got %d", ExitAuthFail, cli.ExitCode)
	}
}

func TestRunCLI_LLMExitCodeMapsToCodeLLM(t *testing.T) {
	log := tempLog(t, "scrape")
	_, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "llm.sh"),
		LogPath: log,
	})
	var cli *CLIError
	if !errors.As(err, &cli) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cli.Code != "llm" {
		t.Fatalf("expected Code=llm, got %q", cli.Code)
	}
	if cli.Retryable {
		t.Fatalf("llm failure must be non-retryable")
	}
	if cli.ExitCode != ExitLLMFail {
		t.Fatalf("expected exit %d, got %d", ExitLLMFail, cli.ExitCode)
	}
}

func TestRunCLI_EnvOverrideReplacesArgv(t *testing.T) {
	log := tempLog(t, "scrape")
	// Baseline Argv points at a fixture that would fail; the env override
	// swaps in ok.sh, proving the seam wins over the static Argv.
	t.Setenv(EnvScrapeCmd, strings.Join(fixtureCmd(t, "ok.sh"), " "))
	res, err := RunCLI(context.Background(), CLISpec{
		Name:        "scrape",
		Argv:        fixtureCmd(t, "crash.sh"),
		LogPath:     log,
		EnvOverride: EnvScrapeCmd,
	})
	if err != nil {
		t.Fatalf("expected success from override, got %v", err)
	}
	if !res.OK() {
		t.Fatalf("expected ok=true, got %#v", res.JSON)
	}
}

func TestRunCLI_CancelKillsProcessGroup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process groups + SIGTERM are POSIX-only")
	}
	log := tempLog(t, "scrape")
	ctx, cancel := context.WithCancel(context.Background())

	type result struct {
		err error
	}
	done := make(chan result, 1)
	go func() {
		_, err := RunCLI(ctx, CLISpec{
			Name:    "scrape",
			Argv:    fixtureCmd(t, "sleep.sh"),
			LogPath: log,
		})
		done <- result{err: err}
	}()

	// Give the fixture time to fork the sleep child.
	time.Sleep(500 * time.Millisecond)
	cancel()

	select {
	case r := <-done:
		var cli *CLIError
		if !errors.As(r.err, &cli) {
			t.Fatalf("expected *CLIError, got %T: %v", r.err, r.err)
		}
		if !cli.Retryable {
			t.Fatalf("cancellation must be retryable")
		}
		if !errors.Is(cli.Cause, context.Canceled) {
			t.Fatalf("expected Cause=context.Canceled, got %v", cli.Cause)
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("RunCLI did not honour cancellation within 15s (process group not killed?)")
	}
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if !strings.Contains(lines[len(lines)-1], "event=canceled") {
		t.Fatalf("missing cancellation: %s", b)
	}

}

func TestRunCLI_TimeoutMapsToRetryableTimeout(t *testing.T) {
	log := tempLog(t, "scrape")
	_, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "sleep.sh"),
		LogPath: log,
		Timeout: 300 * time.Millisecond,
	})
	var cli *CLIError
	if !errors.As(err, &cli) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if !cli.Retryable {
		t.Fatalf("timeout must be retryable")
	}
	if !errors.Is(cli.Cause, context.DeadlineExceeded) {
		t.Fatalf("expected Cause=context.DeadlineExceeded, got %v", cli.Cause)
	}
}

func TestRunCLI_PrettyPrintedTailJSONIsOK(t *testing.T) {
	log := tempLog(t, "preflight-llm")
	res, err := RunCLI(context.Background(), CLISpec{
		Name:    "preflight-llm",
		Argv:    fixtureCmd(t, "pretty-json.sh"),
		LogPath: log,
	})
	if err != nil {
		t.Fatalf("pretty-printed ok:true must parse, got %v", err)
	}
	if !res.OK() {
		t.Fatalf("expected ok=true from pretty JSON, got %#v", res.JSON)
	}
	llm, _ := res.JSON["llm"].(map[string]any)
	if llm == nil {
		t.Fatalf("expected llm object, got %#v", res.JSON)
	}
	if llm["kind"] != "ok" {
		t.Fatalf("llm.kind=%v", llm["kind"])
	}
}

func TestRunCLI_ExitZeroNoJSONIsNonRetryable(t *testing.T) {
	log := tempLog(t, "scrape")
	_, err := RunCLI(context.Background(), CLISpec{
		Name:    "scrape",
		Argv:    fixtureCmd(t, "empty.sh"),
		LogPath: log,
	})
	var cli *CLIError
	if !errors.As(err, &cli) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cli.Retryable {
		t.Fatalf("exit-0-without-JSON should be a non-retryable contract bug")
	}
	if cli.ExitCode != 0 {
		t.Fatalf("expected exit 0 preserved, got %d", cli.ExitCode)
	}
}

func TestSplitCommand(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"bash testdata/ok.sh", []string{"bash", "testdata/ok.sh"}},
		{"bash \"spaced dir/ok.sh\"", []string{"bash", "spaced dir/ok.sh"}},
		{"bash 'single quoted'", []string{"bash", "single quoted"}},
		{"env FOO=bar bash ok.sh", []string{"env", "FOO=bar", "bash", "ok.sh"}},
		{"bash a\\ b", []string{"bash", "a b"}},
	}
	for _, c := range cases {
		got, err := splitCommand(c.in)
		if err != nil {
			t.Fatalf("split %q: %v", c.in, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("split %q: got %#v want %#v", c.in, got, c.want)
		}
	}
	if _, err := splitCommand("bash 'unterminated"); err == nil {
		t.Fatalf("expected error for unterminated quote")
	}
}

func TestRetryPredicate_NonCLIErrorIsRetryable(t *testing.T) {
	if !RetryPredicate(errors.New("random")) {
		t.Fatalf("plain errors should be retryable (transient assumption)")
	}
	if RetryPredicate(nil) {
		t.Fatalf("nil must not be retryable")
	}
}

func TestRunCLI_ResolveLogPathDefaults(t *testing.T) {
	// When LogPath is empty, exec.go derives one under
	// <RepoRoot>/data/dbos/logs/<WorkflowID>/<Name>.log. Point RepoRoot
	// at t.TempDir() so the test never touches the repo tree.
	tmp := t.TempDir()
	// go.mod required for RepoRoot to accept the override directory.
	if err := os.WriteFile(filepath.Join(tmp, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatalf("write go.mod: %v", err)
	}
	t.Setenv(EnvRepoRoot, tmp)

	spec := CLISpec{Name: "scrape", WorkflowID: "ig:acme:1"}
	got, err := resolveLogPath(spec)
	if err != nil {
		t.Fatalf("resolveLogPath: %v", err)
	}
	want := filepath.Join(tmp, "data/dbos/logs/ig:acme:1/scrape.log")
	if got != want {
		t.Fatalf("resolveLogPath = %q want %q", got, want)
	}
}

func TestRunCLI_SysProcAttrIsPOSIXOnly(t *testing.T) {
	// Sanity: Setpgid is only meaningful on POSIX. Guarding the whole
	// process-group test on Windows is the right cover; this test just
	// documents the platform expectation.
	if runtime.GOOS == "windows" {
		if syscall.SIGTERM != 0 {
			t.Skip("no-op on windows")
		}
	}
}

// RetryPolicies expose the epic's numbers; guard them here so a future
// edit that changes a MaxRetries or backoff must justify itself in test
// output rather than sneaking through.
func TestRetryPolicies_MatchEpicDesign(t *testing.T) {
	cases := []struct {
		name string
		got  RetryPolicy
		max  int
	}{
		{"scrape", ScrapeRetryPolicy, 2},
		{"igdl", IGDLRetryPolicy, 3},
		{"igunique", IGUniqueRetryPolicy, 1},
		{"iganalyze", IGAnalyzeRetryPolicy, 2},
	}
	for _, c := range cases {
		if c.got.MaxRetries != c.max {
			t.Fatalf("%s MaxRetries = %d want %d", c.name, c.got.MaxRetries, c.max)
		}
		if c.got.BaseInterval != 30*time.Second {
			t.Fatalf("%s BaseInterval = %v want 30s", c.name, c.got.BaseInterval)
		}
		if c.got.MaxInterval != 5*time.Minute {
			t.Fatalf("%s MaxInterval = %v want 5m", c.name, c.got.MaxInterval)
		}
	}
}

func TestRunCLI_DurableRedactedTimeline(t *testing.T) {
	log := tempLog(t, "scrape")
	for i := 0; i < 2; i++ {
		res, err := RunCLI(context.Background(), CLISpec{Name: "scrape", LogPath: log,
			Env:  []string{"IG_PASS=private-password-value"},
			Argv: []string{"bash", "-c", `printf 'password=%s\n' "$IG_PASS"; printf 'Authorization: Bearer abcdef-secret-token\n' >&2; printf '{"ok":true,"value":"private-password-value"}\n'`}})
		if err != nil || res.String("value") != "private-password-value" {
			t.Fatalf("raw JSON classification changed: %#v %v", res, err)
		}
	}
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	body := string(b)
	if strings.Contains(body, "private-password-value") || strings.Contains(body, "abcdef-secret-token") {
		t.Fatalf("secret exposed: %s", body)
	}
	if strings.Count(body, "event=start") != 2 || strings.Count(body, "event=success") != 2 {
		t.Fatalf("missing durable attempts: %s", body)
	}
	for _, line := range strings.Split(strings.TrimSpace(body), "\n") {
		if _, err := time.Parse(time.RFC3339Nano, strings.Fields(line)[0]); err != nil {
			t.Fatalf("missing timestamp: %s", line)
		}
	}
	if !strings.Contains(body, "[stdout]") || !strings.Contains(body, "[stderr]") || !strings.Contains(body, "duration_ms=") {
		t.Fatalf("missing context: %s", body)
	}
}

func TestRunCLI_TimelineTerminalOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name    string
		argv    []string
		timeout time.Duration
		event   string
	}{
		{"failure", []string{"bash", "-c", `echo '{"ok":false,"error":"rejected"}'; exit 3`}, 0, "failure"},
		{"start-failure", []string{"/nonexistent/patronum-test-command"}, 0, "failure"},
		{"timeout", []string{"bash", "-c", "echo waiting; sleep 30"}, 100 * time.Millisecond, "timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := tempLog(t, "stage")
			_, err := RunCLI(context.Background(), CLISpec{Name: "stage", Argv: tc.argv, Timeout: tc.timeout, LogPath: log})
			if err == nil {
				t.Fatal("expected failure")
			}
			b, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(string(b)), "\n")
			if !strings.Contains(lines[0], "event=start") || !strings.Contains(lines[len(lines)-1], "event="+tc.event) {
				t.Fatalf("bad event order: %s", b)
			}
		})
	}
}

func TestRunCLI_LargeOutputAndUnterminatedTail(t *testing.T) {
	log := tempLog(t, "stage")
	res, err := RunCLI(context.Background(), CLISpec{Name: "stage", LogPath: log,
		Argv: []string{"bash", "-c", `head -c 4500000 /dev/zero | tr '\0' x; printf '\n{"ok":true}'`}})
	if err != nil || !res.OK() {
		t.Fatalf("large output lost tail: %v", err)
	}
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), strings.Repeat("x", 4500000)+"\n") {
		t.Fatal("large output was truncated")
	}
	if !strings.Contains(string(b), `{"ok":true}`) {
		t.Fatal("unterminated JSON not logged")
	}
}
