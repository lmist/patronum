package flow

import (
	"os"
	"path/filepath"
	"strings"
)

// LoadDotEnv sets unset environment variables from a .env file. Existing
// process env wins (including values Bun or the shell already exported).
// A missing file is a no-op. Values are never logged.
//
// When path is empty, the file is <RepoRoot>/.env so `go run ./cmd/igflow`
// from any cwd matches `import "dotenv/config"` in the Bun CLIs.
func LoadDotEnv(path string) {
	if path == "" {
		root, err := RepoRoot()
		if err != nil {
			return
		}
		path = filepath.Join(root, ".env")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(line[len("export "):])
		}
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.TrimSpace(line[i+1:])
		if len(v) >= 2 {
			if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
				v = v[1 : len(v)-1]
			}
		}
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
}
