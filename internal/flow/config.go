// Package flow wires durable workflow dependencies for Patronum: the DBOS
// application shell (system database, host lock, doctor). Nothing here
// registers workflows or queues — that lives in the ScrapeJob bead.
package flow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	_ "github.com/dbos-inc/dbos-transact-golang/dbos/driver/sqlite"
	"github.com/lmist/patronum/internal/home"
)

// Application identity. Kept as constants because DBOS pins ownership by
// (AppName, ApplicationVersion) and the ADR says both are fixed for the
// initial release (advanced-versioning.md).
const (
	AppName            = "patronum-igflow"
	ApplicationVersion = "0.1.0"
)

// On-disk layout, relative to the module root.
const (
	relDataDir     = "data/dbos"
	sqliteFileName = "patronum.sqlite"
	lockFileName   = "igflow.lock"
)

// Env overrides.
const (
	EnvRepoRoot      = "IGFLOW_REPO_ROOT"
	EnvDatabaseURL   = "DBOS_SYSTEM_DATABASE_URL"
	EnvAllowPostgres = "IGFLOW_ALLOW_POSTGRES"
)

// RepoRoot returns the module root. It never uses os.Getwd(): the runtime
// caller path is the source of truth so binaries launched from any
// directory find the same data/dbos tree. An IGFLOW_REPO_ROOT env override
// wins (useful for tests and for shipping a portable binary).
func RepoRoot() (string, error) {
	if v := strings.TrimSpace(os.Getenv(EnvRepoRoot)); v != "" {
		abs, err := filepath.Abs(v)
		if err != nil {
			return "", fmt.Errorf("resolve %s=%q: %w", EnvRepoRoot, v, err)
		}
		return abs, nil
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("flow.RepoRoot: runtime.Caller failed")
	}
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			abs, err := filepath.Abs(dir)
			if err != nil {
				return "", err
			}
			return abs, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("flow.RepoRoot: go.mod not found above %s", filepath.Dir(file))
		}
		dir = parent
	}
}

// HomeDir is where collected data, the job database, logs and the saved
// login live. An explicit IGFLOW_REPO_ROOT keeps code and data together
// (tests, portable binaries); otherwise it is PATRONUM_HOME, defaulting to
// ~/Documents/patronum. See internal/home.
func HomeDir() (string, error) {
	if strings.TrimSpace(os.Getenv(EnvRepoRoot)) != "" {
		return RepoRoot()
	}
	return home.Dir()
}

// homeOrRelative is HomeDir for building command arguments: on failure the
// paths stay relative to the working directory, as they always were.
func homeOrRelative() string {
	dir, err := HomeDir()
	if err != nil {
		return ""
	}
	return dir
}

// DatabaseURL returns the DBOS system-database URL. Precedence:
//
//  1. DBOS_SYSTEM_DATABASE_URL (validated: sqlite: is always accepted;
//     anything else requires IGFLOW_ALLOW_POSTGRES=1 to keep the SQLite
//     ADR honest).
//  2. sqlite:<HomeDir>/data/dbos/patronum.sqlite (absolute).
func DatabaseURL() (string, error) {
	if v := strings.TrimSpace(os.Getenv(EnvDatabaseURL)); v != "" {
		if strings.HasPrefix(v, "sqlite:") {
			return v, nil
		}
		if os.Getenv(EnvAllowPostgres) == "1" {
			return v, nil
		}
		return "", fmt.Errorf("flow: %s=%q is not sqlite: and %s!=1", EnvDatabaseURL, v, EnvAllowPostgres)
	}
	root, err := HomeDir()
	if err != nil {
		return "", err
	}
	return "sqlite:" + filepath.Join(root, relDataDir, sqliteFileName), nil
}

// sqlitePath extracts a filesystem path from a sqlite: URL. Returns "" for
// non-sqlite URLs and for in-memory databases. Kept in sync with the DBOS
// parser (dbos/dbos.go handles sqlite:/abs, sqlite:///abs, sqlite:relative,
// sqlite::memory:, and sqlite:file:...).
func sqlitePath(url string) string {
	if !strings.HasPrefix(url, "sqlite:") {
		return ""
	}
	p := strings.TrimPrefix(url, "sqlite:")
	if p == ":memory:" || strings.HasPrefix(p, ":memory:?") {
		return ""
	}
	// sqlite:///abs → /abs, sqlite://abs → abs (invalid per DBOS but harmless here).
	p = strings.TrimPrefix(p, "//")
	if strings.HasPrefix(p, "file:") {
		return p // hand back to the caller; only sql.Open cares about this form
	}
	return p
}

// DataDir is the directory that holds the SQLite system database and the
// host lock file. For the default database URL it is <HomeDir>/data/dbos;
// for a custom sqlite URL it is the parent of the SQLite file; for a
// custom postgres URL (allowed only under IGFLOW_ALLOW_POSTGRES=1) it
// falls back to <HomeDir>/data/dbos so the lock still has a home.
func DataDir() (string, error) {
	url, err := DatabaseURL()
	if err != nil {
		return "", err
	}
	if p := sqlitePath(url); p != "" {
		return filepath.Dir(p), nil
	}
	root, err := HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, relDataDir), nil
}

// LockPath is DataDir()/igflow.lock.
func LockPath() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, lockFileName), nil
}

// NewHostContext acquires the host lock, then builds a DBOS context with
// the pinned AppName/ApplicationVersion. AdminServer is off; the logger
// writes text records to stderr so bare `go run ./cmd/igflow` never
// interleaves DBOS diagnostics with structured stdout. ExecutorID is
// left at DBOS's default ("local") so Launch recovers this machine's
// PENDING workflows (workflow-background.md); the host lock is what makes
// that safe.
//
// The returned release function releases the host lock. Callers must call
// dbos.Shutdown before release to keep the ordering deterministic:
//
//	ctx, release, err := flow.NewHostContext(bg)
//	if err != nil { return err }
//	defer release()
//	defer dbos.Shutdown(ctx, 30*time.Second)
//	dbos.RegisterWorkflow(ctx, ...)
//	if err := dbos.Launch(ctx); err != nil { return err }
func NewHostContext(ctx context.Context) (dbos.Context, func(), error) {
	return newHostContext(ctx, defaultLogger())
}

// NewQuietHostContext is NewHostContext for commands that only read: it is
// used to create an empty system database, so the engine's start-up and
// shutdown chatter would be noise around the one JSON document they print.
func NewQuietHostContext(ctx context.Context) (dbos.Context, func(), error) {
	return newHostContext(ctx, quietLogger())
}

func newHostContext(ctx context.Context, logger *slog.Logger) (dbos.Context, func(), error) {
	dir, err := DataDir()
	if err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, fmt.Errorf("flow: mkdir %s: %w", dir, err)
	}
	release, err := acquireHostLock(filepath.Join(dir, lockFileName))
	if err != nil {
		return nil, nil, err
	}
	dbURL, err := DatabaseURL()
	if err != nil {
		release()
		return nil, nil, err
	}
	dctx, err := dbos.NewContext(ctx, dbos.Config{
		AppName:            AppName,
		ApplicationVersion: ApplicationVersion,
		DatabaseURL:        dbURL,
		AdminServer:        false,
		Logger:             logger,
	})
	if err != nil {
		release()
		return nil, nil, fmt.Errorf("flow: dbos.NewContext: %w", err)
	}
	return dctx, release, nil
}

// NewClient constructs a DBOS client for external use (CLI status, doctor,
// wire helpers). Always sets AppName per client-setup.md so listing
// operations default to this application's rows. Does not take the host
// lock: clients are read-mostly and safe to run alongside a host.
func NewClient(ctx context.Context) (dbos.Client, error) {
	dbURL, err := DatabaseURL()
	if err != nil {
		return nil, err
	}
	client, err := dbos.NewClient(ctx, dbos.ClientConfig{
		AppName:     AppName,
		DatabaseURL: dbURL,
		Logger:      quietLogger(),
	})
	if err != nil {
		return nil, fmt.Errorf("flow: dbos.NewClient: %w", err)
	}
	return client, nil
}

// Shutdown wraps dbos.Shutdown so callers do not need to import dbos just
// to release a context or client.
func Shutdown(c dbos.Client, timeout time.Duration) error {
	return dbos.Shutdown(c, timeout)
}

func defaultLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// quietLogger is for clients and other read-only use: warnings and errors
// only, minus the ones DBOS logs while its own background loops are being
// cancelled at shutdown ("context canceled"), which report nothing wrong.
func quietLogger() *slog.Logger {
	return slog.New(shutdownFilter{slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})})
}

type shutdownFilter struct{ slog.Handler }

func (f shutdownFilter) Handle(ctx context.Context, record slog.Record) error {
	cancelled := false
	record.Attrs(func(attr slog.Attr) bool {
		cancelled = strings.Contains(attr.Value.String(), context.Canceled.Error())
		return !cancelled
	})
	if cancelled {
		return nil
	}
	return f.Handler.Handle(ctx, record)
}

func (f shutdownFilter) WithAttrs(attrs []slog.Attr) slog.Handler {
	return shutdownFilter{f.Handler.WithAttrs(attrs)}
}

func (f shutdownFilter) WithGroup(name string) slog.Handler {
	return shutdownFilter{f.Handler.WithGroup(name)}
}
