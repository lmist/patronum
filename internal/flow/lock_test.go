package flow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestHostLock_SecondAcquireIsHostLocked(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvDatabaseURL, "sqlite:"+filepath.Join(dir, "sys.sqlite"))
	lp := filepath.Join(dir, "igflow.lock")

	release, err := acquireHostLock(lp)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	t.Cleanup(release)

	if _, err := acquireHostLock(lp); !errors.Is(err, ErrHostLocked) {
		t.Fatalf("second acquire err=%v want ErrHostLocked", err)
	}
	if _, err := os.Stat(lp); err != nil {
		t.Fatalf("expected lock file %s to exist: %v", lp, err)
	}
}

func TestHostLock_ReleaseAllowsReacquire(t *testing.T) {
	dir := t.TempDir()
	lp := filepath.Join(dir, "igflow.lock")

	release, err := acquireHostLock(lp)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	release()
	// Idempotent release.
	release()

	release2, err := acquireHostLock(lp)
	if err != nil {
		t.Fatalf("reacquire: %v", err)
	}
	release2()
}

func TestReadLockHolder(t *testing.T) {
	dir := t.TempDir()
	lp := filepath.Join(dir, "igflow.lock")

	// No file yet → zero holder, no error.
	lh, err := ReadLockHolder(lp)
	if err != nil {
		t.Fatalf("empty holder: %v", err)
	}
	if lh.Held || lh.PID != 0 {
		t.Fatalf("expected zero holder, got %+v", lh)
	}

	release, err := acquireHostLock(lp)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)

	lh, err = ReadLockHolder(lp)
	if err != nil {
		t.Fatal(err)
	}
	if !lh.Held {
		t.Fatalf("expected Held=true, got %+v", lh)
	}
	if lh.PID != os.Getpid() {
		t.Fatalf("expected pid=%d, got %+v", os.Getpid(), lh)
	}
}

func TestNewHostContext_SecondReturnsErrHostLocked(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvDatabaseURL, "sqlite:"+filepath.Join(dir, "sys.sqlite"))
	t.Setenv(EnvRepoRoot, dir)

	ctx1, release1, err := NewHostContext(context.Background())
	if err != nil {
		t.Fatalf("first NewHostContext: %v", err)
	}
	t.Cleanup(func() {
		_ = Shutdown(ctx1, 5e9) // 5 seconds in nanoseconds
		release1()
	})

	if _, _, err := NewHostContext(context.Background()); !errors.Is(err, ErrHostLocked) {
		t.Fatalf("second NewHostContext err=%v want ErrHostLocked", err)
	}
}
