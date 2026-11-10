package flow

import (
	"context"
	"database/sql"
	"fmt"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	_ "modernc.org/sqlite"
)

// Report is a diagnostic snapshot of the DBOS system database and host
// lock. It is safe to gather without launching the DBOS runtime.
type Report struct {
	AppName            string     `json:"app_name"`
	ApplicationVersion string     `json:"application_version"`
	DatabaseURL        string     `json:"database_url"`
	DatabasePath       string     `json:"database_path,omitempty"`
	JournalMode        string     `json:"journal_mode,omitempty"`
	Pending            int        `json:"pending"`
	Enqueued           int        `json:"enqueued"`
	LockHolder         LockHolder `json:"lock_holder"`
	GoVersion          string     `json:"go_version"`
	DBOSVersion        string     `json:"dbos_version,omitempty"`
}

// Doctor collects a Report. It never registers or launches workflows.
// PRAGMA journal_mode is read through a private modernc handle (SQLite
// WAL is a persistent DB property, so a fresh handle observes it) and
// PENDING/ENQUEUED counts come from dbos.ListWorkflows on a fresh client.
func Doctor(ctx context.Context) (Report, error) {
	rep := Report{
		AppName:            AppName,
		ApplicationVersion: ApplicationVersion,
		GoVersion:          runtime.Version(),
		DBOSVersion:        dbosModuleVersion(),
	}
	dbURL, err := DatabaseURL()
	if err != nil {
		return rep, err
	}
	rep.DatabaseURL = dbURL

	if lp, err := LockPath(); err == nil {
		if lh, err := ReadLockHolder(lp); err == nil {
			rep.LockHolder = lh
		}
	}

	if p := sqlitePath(dbURL); p != "" {
		rep.DatabasePath = p
		jm, err := readJournalMode(ctx, p)
		if err != nil {
			return rep, err
		}
		rep.JournalMode = jm
	}

	client, err := NewClient(ctx)
	if err != nil {
		return rep, err
	}
	defer func() { _ = Shutdown(client, 5*time.Second) }()

	pending, err := dbos.ListWorkflows(client, dbos.WithFilterStatus(dbos.WorkflowStatusPending))
	if err != nil {
		return rep, fmt.Errorf("flow.Doctor: list pending: %w", err)
	}
	enqueued, err := dbos.ListWorkflows(client, dbos.WithFilterStatus(dbos.WorkflowStatusEnqueued))
	if err != nil {
		return rep, fmt.Errorf("flow.Doctor: list enqueued: %w", err)
	}
	rep.Pending = len(pending)
	rep.Enqueued = len(enqueued)
	return rep, nil
}

func readJournalMode(ctx context.Context, path string) (string, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return "", fmt.Errorf("flow.Doctor: open sqlite %s: %w", path, err)
	}
	defer db.Close()
	row := db.QueryRowContext(ctx, "PRAGMA journal_mode")
	var jm string
	if err := row.Scan(&jm); err != nil {
		return "", fmt.Errorf("flow.Doctor: PRAGMA journal_mode: %w", err)
	}
	return strings.ToLower(jm), nil
}

func dbosModuleVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, d := range info.Deps {
		if d.Path == "github.com/dbos-inc/dbos-transact-golang" {
			return d.Version
		}
	}
	return ""
}
