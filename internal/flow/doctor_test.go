package flow

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

// TestDoctor_ReportsWalAndZeroPending exercises the full bootstrap loop:
// NewHostContext → Launch → Shutdown → Doctor. The persisted SQLite file
// must be journal_mode=wal (DBOS's sqlite pool applies it on open) and
// there must be no pending/enqueued workflows on a fresh database.
func TestDoctor_ReportsWalAndZeroPending(t *testing.T) {
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "sys.sqlite")
	t.Setenv(EnvDatabaseURL, "sqlite:"+dbFile)
	t.Setenv(EnvRepoRoot, dir) // keeps DataDir/LockPath inside dir

	ctx, release, err := NewHostContext(context.Background())
	if err != nil {
		t.Fatalf("NewHostContext: %v", err)
	}
	if err := dbos.Launch(ctx); err != nil {
		release()
		t.Fatalf("dbos.Launch: %v", err)
	}
	if err := Shutdown(ctx, 10*time.Second); err != nil {
		release()
		t.Fatalf("Shutdown: %v", err)
	}
	release()

	if _, err := os.Stat(dbFile); err != nil {
		t.Fatalf("expected sqlite file %s to exist: %v", dbFile, err)
	}

	rep, err := Doctor(context.Background())
	if err != nil {
		t.Fatalf("Doctor: %v", err)
	}
	if rep.AppName != AppName {
		t.Errorf("AppName=%q want %q", rep.AppName, AppName)
	}
	if rep.ApplicationVersion != ApplicationVersion {
		t.Errorf("ApplicationVersion=%q want %q", rep.ApplicationVersion, ApplicationVersion)
	}
	if rep.JournalMode != "wal" {
		t.Errorf("JournalMode=%q want wal", rep.JournalMode)
	}
	if rep.Pending != 0 {
		t.Errorf("Pending=%d want 0", rep.Pending)
	}
	if rep.Enqueued != 0 {
		t.Errorf("Enqueued=%d want 0", rep.Enqueued)
	}
	if rep.DatabasePath == "" {
		t.Errorf("DatabasePath is empty")
	}
	if rep.GoVersion == "" {
		t.Errorf("GoVersion is empty")
	}
	if rep.LockHolder.Path == "" {
		t.Errorf("LockHolder.Path is empty")
	}
	if rep.LockHolder.Held {
		t.Errorf("LockHolder.Held=true after Shutdown/release")
	}
}
