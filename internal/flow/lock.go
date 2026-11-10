package flow

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ErrHostLocked is returned by NewHostContext when another igflow host is
// already running against the same data dir. The CLI translates this to
// exit code 3.
var ErrHostLocked = errors.New("igflow host lock is held by another process")

// acquireHostLock takes an exclusive, non-blocking flock(2) on path and
// stamps <pid> <RFC3339Nano start> into the file for doctor(1). Returns a
// release function that unlocks and closes the file descriptor.
//
// The lock is held by the process until release is called or the process
// exits; the kernel releases flock automatically on process death, so a
// stale pid+time record in the file is only informational.
func acquireHostLock(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("flow: open %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrHostLocked
		}
		return nil, fmt.Errorf("flow: flock %s: %w", path, err)
	}
	body := fmt.Sprintf("%d %s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339Nano))
	_ = f.Truncate(0)
	if _, err := f.WriteAt([]byte(body), 0); err != nil {
		// Non-fatal: keep the lock even if the stamp fails.
	}
	_ = f.Sync()

	var released bool
	return func() {
		if released {
			return
		}
		released = true
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// LockHolder describes the current holder of the host lock, based on the
// on-disk stamp plus a live probe. All fields are best-effort: an empty
// LockHolder means "no evidence of a host".
type LockHolder struct {
	Path      string    `json:"path"`
	PID       int       `json:"pid,omitempty"`
	StartTime time.Time `json:"start_time,omitempty"`
	Held      bool      `json:"held"`
}

// ReadLockHolder parses the on-disk lock stamp without acquiring the lock,
// then probes the flock to decide whether the stamp is live or stale.
func ReadLockHolder(path string) (LockHolder, error) {
	lh := LockHolder{Path: path}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return lh, nil
		}
		return lh, err
	}
	parts := strings.Fields(strings.TrimSpace(string(b)))
	if len(parts) >= 1 {
		if pid, err := strconv.Atoi(parts[0]); err == nil {
			lh.PID = pid
		}
	}
	if len(parts) >= 2 {
		if t, err := time.Parse(time.RFC3339Nano, parts[1]); err == nil {
			lh.StartTime = t
		}
	}
	lh.Held = probeHostLockHeld(path)
	return lh, nil
}

// probeHostLockHeld reports whether path is currently flock'd by any
// process. Implementation: open a read handle and try a non-blocking
// exclusive flock; EWOULDBLOCK means somebody else holds it. On success
// we release immediately — flock LOCK_UN on a fd we just acquired does
// not affect other holders.
func probeHostLockHeld(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.Is(err, syscall.EWOULDBLOCK)
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}
