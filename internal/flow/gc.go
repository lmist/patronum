package flow

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	_ "modernc.org/sqlite"
)

const defaultGCRetention = 30 * 24 * time.Hour

// DefaultGCRetentionString is the CLI default retention.
func DefaultGCRetentionString() string { return "30d" }

// GCOptions controls igflow garbage collection.
type GCOptions struct {
	OlderThan  time.Duration
	KeepErrors bool
	DryRun     bool
	Now        time.Time
}

// GCSummary is the JSON-safe result of a garbage-collection run.
type GCSummary struct {
	OK             bool      `json:"ok"`
	DryRun         bool      `json:"dryRun"`
	Cutoff         time.Time `json:"cutoff"`
	OlderThan      string    `json:"olderThan"`
	KeepErrors     bool      `json:"keepErrors"`
	Candidates     int       `json:"candidates"`
	Deleted        int       `json:"deleted"`
	LogDirsRemoved int       `json:"logDirsRemoved"`
	WALBeforeBytes int64     `json:"walBeforeBytes"`
	WALAfterBytes  int64     `json:"walAfterBytes"`
	WorkflowIDs    []string  `json:"workflowIds"`
}

// GC prunes old terminal igflow workflows, checkpoints the SQLite WAL, and
// removes matching data/dbos/logs/<workflow-id>/ directories. It refuses to run
// while the host lock is held so a live host never loses workflow state or logs.
func GC(ctx context.Context, client dbos.Client, opts GCOptions) (GCSummary, error) {
	if opts.OlderThan < 0 {
		return GCSummary{}, errors.New("flow.GC: OlderThan must be non-negative")
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	cutoff := now.Add(-opts.OlderThan)
	summary := GCSummary{OK: true, DryRun: opts.DryRun, Cutoff: cutoff, OlderThan: opts.OlderThan.String(), KeepErrors: opts.KeepErrors}

	lockPath, err := LockPath()
	if err != nil {
		return summary, err
	}
	lh, err := ReadLockHolder(lockPath)
	if err != nil {
		return summary, err
	}
	if lh.Held {
		return summary, ErrHostLocked
	}

	ids, err := gcCandidateIDs(client, cutoff, opts.KeepErrors)
	if err != nil {
		return summary, err
	}
	summary.Candidates = len(ids)
	summary.WorkflowIDs = ids

	dbURL, err := DatabaseURL()
	if err != nil {
		return summary, err
	}
	dbPath := sqlitePath(dbURL)
	if dbPath != "" && !strings.HasPrefix(dbPath, "file:") {
		summary.WALBeforeBytes = fileSize(dbPath + "-wal")
	}

	if !opts.DryRun && len(ids) > 0 {
		for start := 0; start < len(ids); start += 100 {
			end := start + 100
			if end > len(ids) {
				end = len(ids)
			}
			if err := dbos.DeleteWorkflows(client, ids[start:end], dbos.WithDeleteChildren()); err != nil {
				return summary, err
			}
			summary.Deleted += end - start
		}
		n, err := pruneLogDirs(ids)
		if err != nil {
			return summary, err
		}
		summary.LogDirsRemoved = n
	}

	if dbPath != "" && !strings.HasPrefix(dbPath, "file:") {
		if !opts.DryRun {
			if err := checkpointWAL(ctx, dbPath); err != nil {
				return summary, err
			}
		}
		summary.WALAfterBytes = fileSize(dbPath + "-wal")
	}
	return summary, nil
}

func gcCandidateIDs(client dbos.Client, cutoff time.Time, keepErrors bool) ([]string, error) {
	statuses := []dbos.WorkflowStatusType{dbos.WorkflowStatusSuccess, dbos.WorkflowStatusCancelled}
	if !keepErrors {
		statuses = append(statuses, dbos.WorkflowStatusError)
	}
	seen := map[string]bool{}
	var ids []string
	for _, status := range statuses {
		wfs, err := dbos.ListWorkflows(client,
			dbos.WithFilterStatus(status),
			dbos.WithFilterCompletedBefore(cutoff),
			dbos.WithFilterWorkflowIDPrefix("ig:"),
			dbos.WithFilterLimit(10000),
		)
		if err != nil {
			return nil, err
		}
		for _, wf := range wfs {
			if !seen[wf.ID] {
				seen[wf.ID] = true
				ids = append(ids, wf.ID)
			}
		}
	}
	return ids, nil
}

func checkpointWAL(ctx context.Context, dbPath string) error {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("flow.GC: open sqlite %s: %w", dbPath, err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return fmt.Errorf("flow.GC: wal_checkpoint(TRUNCATE): %w", err)
	}
	return nil
}

func pruneLogDirs(ids []string) (int, error) {
	dir, err := DataDir()
	if err != nil {
		return 0, err
	}
	logs := filepath.Join(dir, "logs")
	entries, err := os.ReadDir(logs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	matches := func(name string) bool {
		for _, id := range ids {
			if name == id || strings.HasPrefix(name, id+":") {
				return true
			}
		}
		return false
	}
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() && matches(entry.Name()) {
			if err := os.RemoveAll(filepath.Join(logs, entry.Name())); err != nil {
				return removed, err
			}
			removed++
		}
	}
	return removed, nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
