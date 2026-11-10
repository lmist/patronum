package home

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirDefaultsToDocumentsPatronum(t *testing.T) {
	t.Setenv(Env, "")
	user, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no user home directory")
	}
	got, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(user, "Documents", "patronum"); got != want {
		t.Fatalf("Dir() = %q, want %q", got, want)
	}
}

func TestDirHonoursOverrideAndExpandsTilde(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(Env, dir)
	if got, _ := Dir(); got != dir {
		t.Fatalf("Dir() = %q, want %q", got, dir)
	}
	if got := Path("data", "media", "h"); got != filepath.Join(dir, "data", "media", "h") {
		t.Fatalf("Path() = %q", got)
	}
	user, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no user home directory")
	}
	t.Setenv(Env, "~/srv/patronum")
	if got, _ := Dir(); got != filepath.Join(user, "srv", "patronum") {
		t.Fatalf("Dir() with ~ = %q", got)
	}
}
