package flow

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotEnv_FillsMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	body := "# comment\n" +
		"export IG_USER=fromfile\n" +
		"IG_PASS='p as s'\n" +
		"QWEN_API_KEY=\"sk-quoted\"\n" +
		"IGNORED_NO_EQUALS\n" +
		"=novaluekey\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IG_USER", "")
	t.Setenv("IG_PASS", "")
	t.Setenv("QWEN_API_KEY", "")

	LoadDotEnv(path)

	if got := os.Getenv("IG_USER"); got != "fromfile" {
		t.Fatalf("IG_USER = %q, want fromfile", got)
	}
	if got := os.Getenv("IG_PASS"); got != "p as s" {
		t.Fatalf("IG_PASS = %q", got)
	}
	if got := os.Getenv("QWEN_API_KEY"); got != "sk-quoted" {
		t.Fatalf("QWEN_API_KEY = %q", got)
	}
}

func TestLoadDotEnv_DoesNotOverrideExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("IG_USER=fromfile\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IG_USER", "already")

	LoadDotEnv(path)

	if got := os.Getenv("IG_USER"); got != "already" {
		t.Fatalf("IG_USER = %q, want already", got)
	}
}

func TestLoadDotEnv_MissingFileIsNoop(t *testing.T) {
	t.Setenv("IG_USER", "keep")
	LoadDotEnv(filepath.Join(t.TempDir(), "no-such.env"))
	if got := os.Getenv("IG_USER"); got != "keep" {
		t.Fatalf("IG_USER = %q, want keep", got)
	}
}

func TestLoadDotEnv_EmptyPathUsesRepoRoot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module t\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("IGFLOW_DOTENV_PROBE=yes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvRepoRoot, dir)
	t.Setenv("IGFLOW_DOTENV_PROBE", "")

	LoadDotEnv("")

	if got := os.Getenv("IGFLOW_DOTENV_PROBE"); got != "yes" {
		t.Fatalf("IGFLOW_DOTENV_PROBE = %q, want yes (loaded <RepoRoot>/.env)", got)
	}
}

func TestLoadDotEnvThenCheckEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("IG_USER=u\nIG_PASS=p\nQWEN_API_KEY=k\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IG_USER", "")
	t.Setenv("IG_PASS", "")
	t.Setenv("QWEN_API_KEY", "")
	t.Setenv("DASHSCOPE_API_KEY", "")
	t.Setenv("ALIBABA_API_KEY", "")

	if _, err := checkEnv(); err == nil {
		t.Fatal("expected missing env before LoadDotEnv")
	}
	LoadDotEnv(path)
	if _, err := checkEnv(); err != nil {
		t.Fatalf("checkEnv after LoadDotEnv: %v", err)
	}
}
