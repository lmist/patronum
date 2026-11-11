package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

func TestHelpTextDocumentsContract(t *testing.T) {
	for _, want := range []string{
		"run", "status", "list", "steps", "resume", "cancel", "doctor", "gc",
		"--handle", "--url", "--max", "--no-detail", "--skip-reels",
		"--force-login", "--fresh", "--skip-download", "--skip-unique",
		"--skip-analyze", "--skip-kb", "--dl-workers", "--analyze-workers", "--all-frames",
		"--scroll-rounds", "--timeout", "--workflow-id", "--no-preflight",
		"--older-than", "--keep-errors", "--dry-run",
		"0 ok", "1 job failed", "2 usage", "3 host lock held",
		"4 database error", "5 precondition failed", "patronum login", "QWEN_API_KEY", ".env",
	} {
		t.Run(want, func(t *testing.T) {
			if !strings.Contains(helpText(), want) {
				t.Fatalf("helpText() does not contain %q", want)
			}
		})
	}
}

func TestNewestAttachableWorkflowDoesNotReturnStaleSuccess(t *testing.T) {
	workflows := []dbos.WorkflowStatus{
		{ID: "ig:alice:200-child", Status: dbos.WorkflowStatusPending, ParentWorkflowID: "ig:alice:200"},
		{ID: "ig:alice:200", Status: dbos.WorkflowStatusError},
		{ID: "ig:alice:100", Status: dbos.WorkflowStatusSuccess},
	}
	if id, ok := newestAttachableWorkflow(workflows); ok {
		t.Fatalf("selected stale workflow %q after newest parent failed", id)
	}
}

func TestNewestAttachableWorkflowSelectsNewestActiveParent(t *testing.T) {
	workflows := []dbos.WorkflowStatus{
		{ID: "ig:alice:200-child", Status: dbos.WorkflowStatusPending, ParentWorkflowID: "ig:alice:200"},
		{ID: "ig:alice:200", Status: dbos.WorkflowStatusPending},
		{ID: "ig:alice:100", Status: dbos.WorkflowStatusSuccess},
	}
	id, ok := newestAttachableWorkflow(workflows)
	if !ok || id != "ig:alice:200" {
		t.Fatalf("selected (%q, %t), want newest active parent", id, ok)
	}
}

func TestUnknownCommandReturnsUsageJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runCLI(context.Background(), []string{"wat"}, &stdout, &stderr)
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	var got errorResult
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.OK || !strings.Contains(got.Error, "unknown command") {
		t.Fatalf("result = %+v", got)
	}
	if !strings.Contains(stderr.String(), "Usage: igflow") {
		t.Fatalf("stderr lacks usage: %s", stderr.String())
	}
}

func TestRunCLILoadsDotEnvFromRepoRoot(t *testing.T) {
	setFreshDatabase(t)
	dir := os.Getenv("IGFLOW_REPO_ROOT")
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("IGFLOW_DOTENV_PROBE=fromfile\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IGFLOW_DOTENV_PROBE", "")

	var stdout, stderr bytes.Buffer
	code := runCLI(context.Background(), []string{"doctor"}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit code = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if got := os.Getenv("IGFLOW_DOTENV_PROBE"); got != "fromfile" {
		t.Fatalf("IGFLOW_DOTENV_PROBE = %q, want fromfile (runCLI should load <RepoRoot>/.env)", got)
	}
}

func TestDoctorInitializesFreshDatabaseInWALMode(t *testing.T) {
	setFreshDatabase(t)
	var stdout, stderr bytes.Buffer
	code := runCLI(context.Background(), []string{"doctor"}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit code = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	var got doctorResult
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.JournalMode != "wal" {
		t.Fatalf("journalMode = %q, want wal", got.JournalMode)
	}
	if got.AppName != flowAppNameForTest {
		t.Fatalf("appName = %q", got.AppName)
	}
}

func TestListFreshDatabasePrintsEmptyArray(t *testing.T) {
	setFreshDatabase(t)
	var stdout, stderr bytes.Buffer
	code := runCLI(context.Background(), []string{"list"}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit code = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if strings.TrimSpace(stdout.String()) != "[]" {
		t.Fatalf("stdout = %q, want []", stdout.String())
	}
}

const flowAppNameForTest = "patronum-igflow"

func setFreshDatabase(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("DBOS_SYSTEM_DATABASE_URL", "sqlite:"+filepath.Join(dir, "system.sqlite"))
	t.Setenv("IGFLOW_REPO_ROOT", dir)
}
