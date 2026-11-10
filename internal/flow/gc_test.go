package flow

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	_ "modernc.org/sqlite"
)

func TestGCDeletesOnlyOldFinishedIgWorkflowsAndLogs(t *testing.T) {
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "sys.sqlite")
	t.Setenv(EnvRepoRoot, dir)
	t.Setenv(EnvDatabaseURL, "sqlite:"+dbFile)

	host, release, err := NewHostContext(context.Background())
	if err != nil {
		t.Fatalf("NewHostContext: %v", err)
	}
	if err := RegisterAll(host); err != nil {
		release()
		t.Fatalf("RegisterAll: %v", err)
	}
	if err := dbos.Launch(host); err != nil {
		release()
		t.Fatalf("Launch: %v", err)
	}

	fake := newFakeStages()
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })
	oldID := runFinishedWorkflow(t, host, "oldgc")
	newID := runFinishedWorkflow(t, host, "newgc")
	otherID := "other:workflow"
	insertForeignFinishedWorkflow(t, dbFile, otherID, time.Now().Add(-60*24*time.Hour))

	if err := Shutdown(host, 10*time.Second); err != nil {
		release()
		t.Fatalf("Shutdown: %v", err)
	}
	release()

	oldCompleted := time.Now().Add(-60 * 24 * time.Hour)
	setWorkflowCompletedAt(t, dbFile, oldID, oldCompleted)
	setWorkflowCompletedAt(t, dbFile, newID, time.Now())
	logs := filepath.Join(dir, "logs")
	for _, id := range []string{oldID, oldID + ":child", newID, otherID} {
		if err := os.MkdirAll(filepath.Join(logs, id), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	client, err := NewClient(context.Background())
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer Shutdown(client, 5*time.Second)
	summary, err := GC(context.Background(), client, GCOptions{OlderThan: 30 * 24 * time.Hour})
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if summary.Deleted != 1 || summary.Candidates != 1 || len(summary.WorkflowIDs) != 1 || summary.WorkflowIDs[0] != oldID {
		t.Fatalf("summary = %+v, want only %s", summary, oldID)
	}
	if _, err := dbos.RetrieveWorkflow[ScrapeResult](client, oldID); err == nil {
		t.Fatalf("old workflow still exists")
	}
	if _, err := dbos.RetrieveWorkflow[ScrapeResult](client, newID); err != nil {
		t.Fatalf("new workflow missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(logs, oldID)); !os.IsNotExist(err) {
		t.Fatalf("old log dir still exists or stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(logs, oldID+":child")); !os.IsNotExist(err) {
		t.Fatalf("child log dir still exists or stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(logs, newID)); err != nil {
		t.Fatalf("new log dir removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(logs, otherID)); err != nil {
		t.Fatalf("foreign log dir removed: %v", err)
	}
}

func TestGCKeepErrorsPreservesOldErrorWorkflows(t *testing.T) {
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "sys.sqlite")
	t.Setenv(EnvRepoRoot, dir)
	t.Setenv(EnvDatabaseURL, "sqlite:"+dbFile)
	host, release, err := NewHostContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := dbos.Launch(host); err != nil {
		release()
		t.Fatal(err)
	}
	if err := Shutdown(host, 10*time.Second); err != nil {
		release()
		t.Fatal(err)
	}
	release()
	id := "ig:errorgc:1"
	insertFinishedWorkflow(t, dbFile, id, "ERROR", time.Now().Add(-60*24*time.Hour))
	client, err := NewClient(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer Shutdown(client, 5*time.Second)
	summary, err := GC(context.Background(), client, GCOptions{OlderThan: 30 * 24 * time.Hour, KeepErrors: true})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Candidates != 0 || summary.Deleted != 0 {
		t.Fatalf("summary=%+v, want no deletion", summary)
	}
}

func runFinishedWorkflow(t *testing.T, ctx dbos.Context, handle string) string {
	t.Helper()
	in := defaultInput(handle)
	id := BuildWorkflowID(handle, time.Now())
	h, err := EnqueueScrapeJob(ctx, in, id)
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if _, err := h.GetResult(); err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	return id
}

func setWorkflowCompletedAt(t *testing.T, dbFile, id string, completed time.Time) {
	t.Helper()
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ms := completed.UnixMilli()
	if _, err := db.Exec(`UPDATE workflow_status SET completed_at = ?, updated_at = ? WHERE workflow_uuid = ?`, ms, ms, id); err != nil {
		t.Fatal(err)
	}
}

func insertForeignFinishedWorkflow(t *testing.T, dbFile, id string, completed time.Time) {
	insertFinishedWorkflow(t, dbFile, id, "SUCCESS", completed)
}
func insertFinishedWorkflow(t *testing.T, dbFile, id, status string, completed time.Time) {
	t.Helper()
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ms := completed.UnixMilli()
	_, err = db.Exec(`INSERT INTO workflow_status (workflow_uuid, status, name, created_at, updated_at, application_version, application_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, status, "fixture", ms, ms, ApplicationVersion, AppName, ms)
	if err != nil {
		t.Fatal(err)
	}
}

func TestGCRefusesWhenHostLockHeld(t *testing.T) {
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "sys.sqlite")
	t.Setenv(EnvRepoRoot, dir)
	t.Setenv(EnvDatabaseURL, "sqlite:"+dbFile)
	host, release, err := NewHostContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := dbos.Launch(host); err != nil {
		release()
		t.Fatal(err)
	}
	defer func() { _ = Shutdown(host, 10*time.Second); release() }()
	client, err := NewClient(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer Shutdown(client, 5*time.Second)
	_, err = GC(context.Background(), client, GCOptions{OlderThan: time.Hour})
	if !errors.Is(err, ErrHostLocked) {
		t.Fatalf("err=%v, want ErrHostLocked", err)
	}
}
