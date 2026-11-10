package flow

import (
	"context"
	"os"
	"path/filepath"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

const (
	// EnvTestCrashAfter names a stage; after that stage's real work is
	// checkpointed, crashAfter exits the process once so recovery tests
	// can prove the next launch replays the completed step.
	EnvTestCrashAfter = "IGFLOW_TEST_CRASH_AFTER"
	// EnvTestCrashDir is the directory for the one-shot crash marker.
	EnvTestCrashDir = "IGFLOW_TEST_CRASH_DIR"
)

// crashAfter is a tiny step run after a completed stage. The env read
// lives inside the step (workflow-determinism.md). Production jobs
// take the no-op path.
func crashAfter(ctx dbos.Context, stage string) error {
	_, err := dbos.RunAsStep(ctx, func(context.Context) (bool, error) {
		maybeTestCrash(stage)
		return true, nil
	}, dbos.WithStepName("crash-after-"+stage), dbos.WithStepMaxRetries(0))
	return err
}

// maybeTestCrash exits 137 the first time IGFLOW_TEST_CRASH_AFTER matches
// stage. A marker file makes the second invocation a no-op so recovery
// can continue.
func maybeTestCrash(stage string) {
	want := os.Getenv(EnvTestCrashAfter)
	if want == "" || want != stage {
		return
	}
	dir := os.Getenv(EnvTestCrashDir)
	if dir == "" {
		dir = os.TempDir()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	marker := filepath.Join(dir, "crashed-"+stage)
	if _, err := os.Stat(marker); err == nil {
		return
	}
	_ = os.WriteFile(marker, []byte("1"), 0o644)
	os.Exit(137)
}
