package flow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepoRoot_Default(t *testing.T) {
	t.Setenv(EnvRepoRoot, "")
	root, err := RepoRoot()
	if err != nil {
		t.Fatalf("RepoRoot: %v", err)
	}
	if !filepath.IsAbs(root) {
		t.Fatalf("want absolute path, got %q", root)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("expected go.mod at %s: %v", root, err)
	}
	// Sanity: this file lives under <root>/internal/flow.
	want := filepath.Join(root, "internal", "flow")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("expected %s to exist: %v", want, err)
	}
}

func TestRepoRoot_EnvOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvRepoRoot, dir)
	got, err := RepoRoot()
	if err != nil {
		t.Fatal(err)
	}
	// filepath.Abs collapses symlinks-in-path differences that TempDir may
	// introduce on macOS (/var vs /private/var); compare via EvalSymlinks.
	if resolve(t, got) != resolve(t, dir) {
		t.Fatalf("want %s, got %s", dir, got)
	}
}

func resolve(t *testing.T, p string) string {
	t.Helper()
	rp, err := filepath.EvalSymlinks(p)
	if err != nil {
		return p
	}
	return rp
}

func TestDatabaseURL_DefaultAbsoluteSQLite(t *testing.T) {
	t.Setenv(EnvDatabaseURL, "")
	t.Setenv(EnvAllowPostgres, "")
	url, err := DatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "sqlite:") {
		t.Fatalf("want sqlite: prefix, got %q", url)
	}
	path := strings.TrimPrefix(url, "sqlite:")
	if !filepath.IsAbs(path) {
		t.Fatalf("want absolute path, got %q", path)
	}
	if !strings.HasSuffix(path, filepath.Join("data", "dbos", "patronum.sqlite")) {
		t.Fatalf("want default sqlite path suffix, got %q", path)
	}
}

func TestDatabaseURL_EnvOverride(t *testing.T) {
	override := "sqlite:" + filepath.Join(t.TempDir(), "custom.sqlite")
	t.Setenv(EnvDatabaseURL, override)
	t.Setenv(EnvAllowPostgres, "")
	got, err := DatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if got != override {
		t.Fatalf("want %q, got %q", override, got)
	}
}

func TestDatabaseURL_RejectPostgresByDefault(t *testing.T) {
	t.Setenv(EnvDatabaseURL, "postgres://user:pass@localhost/db")
	t.Setenv(EnvAllowPostgres, "")
	if _, err := DatabaseURL(); err == nil {
		t.Fatal("expected non-sqlite rejection error, got nil")
	}
}

func TestDatabaseURL_AllowPostgresOptIn(t *testing.T) {
	url := "postgres://user:pass@localhost/db"
	t.Setenv(EnvDatabaseURL, url)
	t.Setenv(EnvAllowPostgres, "1")
	got, err := DatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if got != url {
		t.Fatalf("want %q, got %q", url, got)
	}
}

func TestDataDirTracksSQLiteURL(t *testing.T) {
	dbFile := filepath.Join(t.TempDir(), "sub", "sys.sqlite")
	t.Setenv(EnvDatabaseURL, "sqlite:"+dbFile)
	dir, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Dir(dbFile) {
		t.Fatalf("DataDir=%q want %q", dir, filepath.Dir(dbFile))
	}
	lp, err := LockPath()
	if err != nil {
		t.Fatal(err)
	}
	if lp != filepath.Join(filepath.Dir(dbFile), "igflow.lock") {
		t.Fatalf("LockPath=%q", lp)
	}
}

func TestSQLitePathParsing(t *testing.T) {
	cases := map[string]string{
		"sqlite:/tmp/x.db":     "/tmp/x.db",
		"sqlite:///tmp/x.db":   "/tmp/x.db",
		"sqlite:relative.db":   "relative.db",
		"sqlite::memory:":      "",
		"postgres://x/y":       "",
	}
	for in, want := range cases {
		if got := sqlitePath(in); got != want {
			t.Errorf("sqlitePath(%q)=%q want %q", in, got, want)
		}
	}
}
