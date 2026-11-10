// Package home answers one question: where does Patronum keep what it
// collects?
//
// Everything the app writes (profiles, media, analysis, the job database,
// logs, the saved Chrome login, caches) lives under one folder, the home.
// It is ~/Documents/patronum unless the operator sets PATRONUM_HOME, which
// is how a server points it at a data volume. The TypeScript side reads the
// same variable in src/paths.ts; keep the two in step.
package home

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Env is the environment variable that relocates the home.
const Env = "PATRONUM_HOME"

// Default is ~/Documents/patronum.
func Default() (string, error) {
	user, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("patronum home: %w", err)
	}
	return filepath.Join(user, "Documents", "patronum"), nil
}

// Dir returns the absolute home folder: PATRONUM_HOME when set (a leading
// ~ is expanded), otherwise Default. It does not create the folder.
func Dir() (string, error) {
	value := strings.TrimSpace(os.Getenv(Env))
	if value == "" {
		return Default()
	}
	if value == "~" || strings.HasPrefix(value, "~/") {
		user, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("patronum home: %w", err)
		}
		value = filepath.Join(user, strings.TrimPrefix(value, "~"))
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve %s=%q: %w", Env, value, err)
	}
	return abs, nil
}

// Path joins parts under the home. On the rare failure to find the home it
// falls back to a path relative to the working directory.
func Path(parts ...string) string {
	dir, err := Dir()
	if err != nil {
		return filepath.Join(parts...)
	}
	return filepath.Join(append([]string{dir}, parts...)...)
}
