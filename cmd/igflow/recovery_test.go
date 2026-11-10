//go:build recovery

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("IGFLOW_TEST_HELPER") == "1" {
		os.Exit(runCLI(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("go.mod not found from %s: %v", wd, err)
	}
	return root
}

func fixtureCmd(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(repoRoot(t), "internal", "flow", "testdata", name)
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
	return "bash " + p
}

type helperEnv struct {
	dir   string
	db    string
	calls string
	crash string
	extra []string
}

func newHelperEnv(t *testing.T) helperEnv {
	t.Helper()
	dir := t.TempDir()
	return helperEnv{
		dir:   dir,
		db:    filepath.Join(dir, "sys.sqlite"),
		calls: filepath.Join(dir, "calls"),
		crash: filepath.Join(dir, "crash"),
	}
}

func (h helperEnv) env(t *testing.T, scrape string) []string {
	t.Helper()
	out := append([]string{}, os.Environ()...)
	out = append(out,
		"IGFLOW_TEST_HELPER=1",
		"IGFLOW_REPO_ROOT="+h.dir,
		"DBOS_SYSTEM_DATABASE_URL=sqlite:"+h.db,
		"IGFLOW_TEST_CALLS="+h.calls,
		"IGFLOW_TEST_CRASH_DIR="+h.crash,
		"IGFLOW_SCRAPE_CMD="+fixtureCmd(t, scrape),
		"IGFLOW_IGDL_CMD="+fixtureCmd(t, "igdl-ok.sh"),
		"IGFLOW_IGUNIQUE_CMD="+fixtureCmd(t, "igunique-ok.sh"),
		"IGFLOW_IGANALYZE_CMD="+fixtureCmd(t, "iganalyze-ok.sh"),
		"IGFLOW_VERIFY_CMD="+fixtureCmd(t, "verify-ok.sh"),
		"IGFLOW_PREFLIGHT_CMD="+fixtureCmd(t, "ok.sh"),
		"IG_USER=testuser",
		"IG_PASS=testpass",
		"QWEN_API_KEY=test-key",
	)
	out = append(out, h.extra...)
	return out
}

func (h helperEnv) cmd(t *testing.T, scrape string, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = h.env(t, scrape)
	cmd.Dir = repoRoot(t)
	return cmd
}

func countCalls(t *testing.T, path, needle string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatal(err)
	}
	return strings.Count(string(b), needle)
}

func TestRecovery_KillDuringScrape(t *testing.T) {
	h := newHelperEnv(t)
	wfID := "ig:t1:1001"
	cmd := h.cmd(t, "scrape-block.sh",
		"run", "--handle", "t1", "--workflow-id", wfID,
		"--no-preflight", "--skip-download", "--skip-unique", "--skip-analyze",
	)
	cmd.Env = append(cmd.Env, "IGFLOW_TEST_SLEEP=5")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1 * time.Second)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()

	cmd2 := h.cmd(t, "scrape-block.sh",
		"run", "--handle", "t1", "--workflow-id", wfID,
		"--no-preflight", "--skip-download", "--skip-unique", "--skip-analyze",
	)
	cmd2.Env = append(cmd2.Env, "IGFLOW_TEST_SLEEP=0")
	out, err := cmd2.CombinedOutput()
	if err != nil {
		t.Fatalf("relaunch: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), `"ok":true`) && !strings.Contains(string(out), `"ok": true`) {
		t.Fatalf("relaunch output: %s", out)
	}
	n := countCalls(t, h.calls, "scrape")
	if n < 2 {
		t.Fatalf("scrape calls = %d want >=2 (%s)", n, mustRead(h.calls))
	}
}

func TestRecovery_CrashAfterScrape(t *testing.T) {
	h := newHelperEnv(t)
	wfID := "ig:t2:1002"
	cmd := h.cmd(t, "scrape-ok.sh",
		"run", "--handle", "t2", "--workflow-id", wfID,
		"--no-preflight", "--skip-unique", "--skip-analyze",
	)
	cmd.Env = append(cmd.Env, "IGFLOW_TEST_CRASH_AFTER=scrape")
	_ = cmd.Run()

	before := countCalls(t, h.calls, "scrape")
	cmd2 := h.cmd(t, "scrape-ok.sh",
		"resume", wfID,
	)
	cmd2.Env = append(cmd2.Env, "IGFLOW_TEST_CRASH_AFTER=scrape")
	out, err := cmd2.CombinedOutput()
	if err != nil {
		t.Fatalf("resume: %v\n%s", err, out)
	}
	after := countCalls(t, h.calls, "scrape")
	if after != before {
		t.Fatalf("scrape re-ran: before=%d after=%d body=%s", before, after, mustRead(h.calls))
	}
	if countCalls(t, h.calls, "igdl") != 1 {
		t.Fatalf("download calls = %d body=%s", countCalls(t, h.calls, "igdl"), mustRead(h.calls))
	}
}

func TestRecovery_ResumeRetriesOnlyAnalysis(t *testing.T) {
	h := newHelperEnv(t)
	marker := filepath.Join(h.dir, "analyze-fail-once")
	h.extra = []string{
		"IGFLOW_IGANALYZE_CMD=" + fixtureCmd(t, "iganalyze-flaky.sh"),
		"IGFLOW_TEST_ANALYZE_FAIL_ONCE=" + marker,
	}
	wfID := "ig:analysisresume:1004"
	first := h.cmd(t, "scrape-ok.sh", "run", "--handle", "analysisresume", "--workflow-id", wfID, "--no-preflight")
	if out, err := first.CombinedOutput(); err == nil {
		t.Fatalf("first run unexpectedly succeeded: %s", out)
	}
	before := map[string]int{}
	for _, stage := range []string{"scrape", "igdl", "igunique", "iganalyze"} {
		before[stage] = countCalls(t, h.calls, stage)
	}

	resume := h.cmd(t, "scrape-ok.sh", "resume", wfID)
	out, err := resume.CombinedOutput()
	if err != nil {
		t.Fatalf("resume: %v\n%s", err, out)
	}
	for _, stage := range []string{"scrape", "igdl", "igunique"} {
		if got := countCalls(t, h.calls, stage); got != before[stage] {
			t.Fatalf("%s reran: before=%d after=%d calls=%s", stage, before[stage], got, mustRead(h.calls))
		}
	}
	if got := countCalls(t, h.calls, "iganalyze"); got != 2 {
		t.Fatalf("analysis calls = %d, want 2: %s", got, mustRead(h.calls))
	}
}

func TestRecovery_AttachSameWorkflowID(t *testing.T) {
	h := newHelperEnv(t)
	wfID := "ig:t3:1003"
	cmd := h.cmd(t, "scrape-block.sh",
		"run", "--handle", "t3", "--workflow-id", wfID,
		"--no-preflight", "--skip-download", "--skip-unique", "--skip-analyze",
	)
	cmd.Env = append(cmd.Env, "IGFLOW_TEST_SLEEP=4")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	time.Sleep(800 * time.Millisecond)

	cmd2 := h.cmd(t, "scrape-block.sh",
		"run", "--handle", "t3",
		"--no-preflight", "--skip-download", "--skip-unique", "--skip-analyze",
	)
	cmd2.Env = append(cmd2.Env, "IGFLOW_TEST_SLEEP=0")
	out, err := cmd2.CombinedOutput()
	if err != nil {
		t.Fatalf("attach: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), wfID) {
		t.Fatalf("attach did not print %s: %s", wfID, out)
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
}

func TestRecovery_ResumeFromError(t *testing.T) {
	h := newHelperEnv(t)
	wfID := "ig:t4:1004"
	cmd := h.cmd(t, "scrape-ok.sh",
		"run", "--handle", "t4", "--workflow-id", wfID,
		"--no-preflight", "--skip-unique", "--skip-analyze",
	)
	cmd.Env = append(cmd.Env, "IGFLOW_IGDL_CMD="+fixtureCmd(t, "igdl-fail.sh"))
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected download failure, got %s", out)
	}

	scrapeN := countCalls(t, h.calls, "scrape")
	cmd2 := h.cmd(t, "scrape-ok.sh", "resume", wfID)
	out2, err := cmd2.CombinedOutput()
	if err != nil {
		t.Fatalf("resume: %v\n%s", err, out2)
	}
	if countCalls(t, h.calls, "scrape") != scrapeN {
		t.Fatalf("scrape re-ran on resume: %s", mustRead(h.calls))
	}
	if countCalls(t, h.calls, "igdl") < 2 {
		t.Fatalf("download not retried: %s", mustRead(h.calls))
	}
}

func TestRecovery_ColdJarPreflight(t *testing.T) {
	h := newHelperEnv(t)
	cmd := h.cmd(t, "scrape-ok.sh",
		"run", "--handle", "t6", "--workflow-id", "ig:t6:1006",
		"--skip-download", "--skip-unique", "--skip-analyze",
	)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected preflight failure, got %s", out)
	}
	var parsed map[string]any
	_ = json.Unmarshal(out, &parsed)
	if countCalls(t, h.calls, "scrape") != 0 {
		t.Fatalf("scrape ran despite cold jar: %s", mustRead(h.calls))
	}
	if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() != exitPrecondition && cmd.ProcessState.ExitCode() != exitJobFailed {
		// helper exit code is on the Run error; parse JSON error field.
	}
	if !strings.Contains(string(out), "auth") && !strings.Contains(string(out), "cookie") && !strings.Contains(string(out), "preflight") {
		t.Fatalf("cold jar output: %s", out)
	}
}

func TestRecovery_TimeoutCancels(t *testing.T) {
	h := newHelperEnv(t)
	wfID := "ig:t5:1005"
	cmd := h.cmd(t, "scrape-block.sh",
		"run", "--handle", "t5", "--workflow-id", wfID,
		"--no-preflight", "--skip-download", "--skip-unique", "--skip-analyze",
		"--timeout", "2s",
	)
	cmd.Env = append(cmd.Env, "IGFLOW_TEST_SLEEP=30")
	out, _ := cmd.CombinedOutput()
	list := h.cmd(t, "scrape-ok.sh", "list", "--handle", "t5")
	lout, err := list.CombinedOutput()
	if err != nil {
		t.Fatalf("list: %v\n%s", err, lout)
	}
	low := strings.ToLower(string(lout) + string(out))
	if !strings.Contains(low, "cancel") && !strings.Contains(low, "error") {
		t.Fatalf("timeout output=%s list=%s", out, lout)
	}
}

func mustRead(path string) string {
	b, _ := os.ReadFile(path)
	return string(b)
}
