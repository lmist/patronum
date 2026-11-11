package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	"github.com/lmist/patronum/internal/flow"
)

const (
	exitOK = iota
	exitJobFailed
	exitUsage
	exitHostLocked
	exitDatabase
	exitPrecondition
)

type errorResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

type progressResult struct {
	Stage string `json:"stage"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

type statusResult struct {
	WorkflowID string          `json:"workflowId"`
	Status     string          `json:"status"`
	Stage      string          `json:"stage,omitempty"`
	Progress   *progressResult `json:"progress,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	Error      string          `json:"error,omitempty"`
}

type listResult struct {
	WorkflowID  string     `json:"workflowId"`
	Handle      string     `json:"handle"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"createdAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
}

type stepResult struct {
	StepID          int    `json:"stepId"`
	Name            string `json:"name"`
	ChildWorkflowID string `json:"childWorkflowId,omitempty"`
	Error           string `json:"error,omitempty"`
}

type doctorResult struct {
	DBPath      string `json:"dbPath"`
	JournalMode string `json:"journalMode"`
	AppName     string `json:"appName"`
	AppVersion  string `json:"appVersion"`
	Pending     int    `json:"pending"`
	LockHeld    bool   `json:"lockHeld"`
	GoVersion   string `json:"goVersion"`
	DBOSVersion string `json:"dbosVersion,omitempty"`
}

func helpText() string {
	return `Usage: igflow <command> [options]

Commands:
  run       Start or attach to a durable Instagram scrape job (host)
  status    Show workflow status and progress events
  list      List workflows
  steps     List workflow steps and child workflows
  resume    Resume a workflow from its last completed step (host)
  cancel    Cancel a workflow and its children
  doctor    Check the DBOS database and host lock
  gc        Prune old finished workflows, checkpoint WAL, and remove logs
  help      Show this help

run options:
  --handle HANDLE          Instagram handle
  --url URL                Instagram profile URL (alternative to --handle)
  --max N                  Maximum posts (default 120)
  --no-detail              Skip post detail extraction
  --skip-reels             Skip reels and standalone feed videos
  --force-login            Force the Instagram login flow
  --fresh                  Ignore stage checkpoints
  --skip-download          Stop after verification
  --skip-unique            Skip unique-media collection
  --skip-analyze           Skip media analysis
  --skip-kb                Deprecated compatibility flag (wiki export is separate)
  --dl-workers N           Download workers (default 8)
  --analyze-workers N      Analysis workers (default 4)
  --all-frames             Analyze every frame rather than per shortcode
  --scroll-rounds N        Maximum profile scroll rounds (0 is automatic)
  --timeout DURATION       Workflow timeout (default 6h)
  --workflow-id ID         Explicit idempotent workflow ID
  --skip-llm-preflight     Skip provider readiness checks; retain auth/tool checks
  --no-preflight           Debug only: skip auth and LLM preflight

list options:
  --status STATUS          pending|enqueued|success|error|cancelled
  --handle HANDLE          Filter workflow IDs by Instagram handle
  --limit N                Maximum results (default 50)

gc options:
  --older-than DURATION    Retain workflows completed within DURATION (default 30d)
  --keep-errors            Keep ERROR workflows; prune only SUCCESS and CANCELLED
  --dry-run                Print candidates without deleting workflows or logs

Exit codes: 0 ok; 1 job failed; 2 usage; 3 host lock held; 4 database error;
5 precondition failed (Instagram auth, LLM, or missing env). igflow loads
.env from the repo root (existing env wins). For exit 5, run "patronum login"
or fix LLM_API_KEY in .env, then resume the job from the dashboard.
`
}

func main() { os.Exit(runCLI(context.Background(), os.Args[1:], os.Stdout, os.Stderr)) }

func runCLI(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	// Bun CLIs load dotenv automatically; bare `go run` does not. Fill
	// unset keys from <RepoRoot>/.env so checkEnv and child CLIs see them.
	flow.LoadDotEnv("")
	if len(args) == 0 {
		fmt.Fprint(stderr, helpText())
		return writeError(stdout, "missing command", exitUsage)
	}
	switch args[0] {
	case "help", "-h", "--help":
		fmt.Fprint(stdout, helpText())
		return exitOK
	case "run":
		return runCommand(ctx, args[1:], stdout, stderr)
	case "resume":
		return resumeCommand(ctx, args[1:], stdout, stderr)
	case "status":
		return statusCommand(ctx, args[1:], stdout, stderr)
	case "list":
		return listCommand(ctx, args[1:], stdout, stderr)
	case "steps":
		return stepsCommand(ctx, args[1:], stdout, stderr)
	case "cancel":
		return cancelCommand(ctx, args[1:], stdout, stderr)
	case "doctor":
		return doctorCommand(ctx, args[1:], stdout, stderr)
	case "gc":
		return gcCommand(ctx, args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], helpText())
		return writeError(stdout, "unknown command: "+args[0], exitUsage)
	}
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, helpText()) }
	return fs
}

func runCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("run", stderr)
	handle := fs.String("handle", "", "Instagram handle")
	profileURL := fs.String("url", "", "Instagram profile URL")
	max := fs.Int("max", 120, "maximum posts")
	noDetail := fs.Bool("no-detail", false, "skip detail extraction")
	skipReels := fs.Bool("skip-reels", false, "skip reels")
	forceLogin := fs.Bool("force-login", false, "force login")
	fresh := fs.Bool("fresh", false, "ignore checkpoints")
	skipDownload := fs.Bool("skip-download", false, "skip download")
	skipUnique := fs.Bool("skip-unique", false, "skip unique")
	skipAnalyze := fs.Bool("skip-analyze", false, "skip analysis")
	skipKB := fs.Bool("skip-kb", true, "deprecated: wiki export is separate")
	dlWorkers := fs.Int("dl-workers", 8, "download workers")
	analyzeWorkers := fs.Int("analyze-workers", 4, "analysis workers")
	allFrames := fs.Bool("all-frames", false, "analyze all frames")
	scrollRounds := fs.Int("scroll-rounds", 0, "scroll rounds")
	timeout := fs.Duration("timeout", 6*time.Hour, "workflow timeout")
	workflowIDFlag := fs.String("workflow-id", "", "workflow ID")
	skipLLMPreflight := fs.Bool("skip-llm-preflight", false, "skip LLM readiness checks")
	noPreflight := fs.Bool("no-preflight", false, "skip preflight")
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 0 || ((*handle == "") == (*profileURL == "")) {
		fmt.Fprint(stderr, "run requires exactly one of --handle or --url\n")
		return writeError(stdout, "run requires exactly one of --handle or --url", exitUsage)
	}
	if *max < 1 || *dlWorkers < 1 || *analyzeWorkers < 1 || *scrollRounds < 0 || *timeout <= 0 {
		return writeError(stdout, "run numeric options must be positive (scroll-rounds may be zero)", exitUsage)
	}
	raw := *handle
	if raw == "" {
		raw = *profileURL
	}
	norm, err := flow.NormalizeHandle(raw)
	if err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	in := flow.JobInput{
		V:                flow.JobInputVersion,
		Handle:           norm,
		ProfileURL:       *profileURL,
		Max:              *max,
		Detail:           !*noDetail,
		SkipReels:        *skipReels,
		ForceLogin:       *forceLogin,
		Fresh:            *fresh,
		SkipDownload:     *skipDownload,
		SkipUnique:       *skipUnique,
		SkipAnalyze:      *skipAnalyze,
		SkipKB:           *skipKB,
		DLWorkers:        *dlWorkers,
		AnalyzeWorkers:   *analyzeWorkers,
		PerShortcode:     !*allFrames,
		AllFrames:        *allFrames,
		ScrollRounds:     *scrollRounds,
		Timeout:          flow.Duration(*timeout),
		NoPreflight:      *noPreflight,
		SkipLLMPreflight: *skipLLMPreflight,
	}
	if err := in.Validate(); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	// Clock read must happen OUTSIDE the workflow (determinism).
	wfID := strings.TrimSpace(*workflowIDFlag)
	if wfID == "" {
		wfID = flow.BuildWorkflowID(in.Handle, time.Now())
	}
	return withHost(ctx, stdout, stderr, in.Timeout.D(), func(host dbos.Context) int {
		handle, err := flow.EnqueueScrapeJob(host, in, wfID)
		if err != nil {
			return writeError(stdout, err.Error(), exitDatabase)
		}
		return awaitJob(ctx, host, stdout, handle, in.Timeout.D())
	}, func() int {
		return attachExisting(ctx, stdout, in, wfID)
	})
}

func resumeCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("resume", stderr)
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 1 {
		return writeError(stdout, "resume requires <workflowId>", exitUsage)
	}
	wfID := fs.Arg(0)
	return withHost(ctx, stdout, stderr, 0, func(host dbos.Context) int {
		handle, err := resumeHandle(host, wfID)
		if err != nil {
			return writeError(stdout, err.Error(), exitDatabase)
		}
		return awaitJob(ctx, host, stdout, handle, 0)
	}, nil)
}

// resumeHandle restarts a workflow from its last completed step.
// DBOS ResumeWorkflow skips SUCCESS and ERROR rows; an ERROR job is
// forked from the first failed step so the repaired CLI can re-run.
func resumeHandle(host dbos.Context, wfID string) (dbos.WorkflowHandle[flow.ScrapeResult], error) {
	workflows, err := dbos.ListWorkflows(host, dbos.WithFilterWorkflowIDPrefix(wfID), dbos.WithFilterLimit(20))
	if err != nil {
		return nil, err
	}
	var status dbos.WorkflowStatusType
	for i := range workflows {
		if workflows[i].ID == wfID {
			status = workflows[i].Status
			break
		}
	}
	if status != dbos.WorkflowStatusError {
		return dbos.ResumeWorkflow[flow.ScrapeResult](host, wfID)
	}
	steps, err := dbos.GetWorkflowSteps(host, wfID, dbos.WithStepsLoadOutput(false))
	if err != nil {
		return nil, err
	}
	start := uint(0)
	for _, s := range steps {
		if s.Error != nil {
			start = uint(s.StepID)
			break
		}
	}
	return dbos.ForkWorkflow[flow.ScrapeResult](host, dbos.ForkWorkflowInput{
		OriginalWorkflowID: wfID,
		StartStep:          start,
	})
}

// withHost acquires the host lock, registers workflows/queues, launches
// DBOS, and hands off a live dbos.Context to fn. Cleanup order matches
// the header comment on flow.NewHostContext: Shutdown, then release.
func withHost(ctx context.Context, stdout, _ io.Writer, timeout time.Duration, fn func(dbos.Context) int, onLocked func() int) int {
	root, release, err := flow.NewHostContext(ctx)
	if err != nil {
		if errors.Is(err, flow.ErrHostLocked) {
			if onLocked != nil {
				return onLocked()
			}
			return writeError(stdout, err.Error(), exitHostLocked)
		}
		return writeError(stdout, err.Error(), exitDatabase)
	}
	defer release()
	// Shutdown must be called on the root context returned by NewHostContext,
	// not on a WithTimeout-derived child (dbos.Shutdown reaches for internals
	// only the root holds and panics otherwise).
	defer func() { _ = flow.Shutdown(root, 30*time.Second) }()
	if err := flow.RegisterAll(root); err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	if err := dbos.Launch(root); err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	host := root
	if timeout > 0 {
		timedCtx, cancel := dbos.WithTimeout(root, timeout)
		defer cancel()
		host = timedCtx
	}
	return fn(host)
}

// attachExisting is the host-lock fallback: a second `igflow run` for an
// in-flight handle attaches as a client (RetrieveWorkflow + GetResult)
// instead of taking the lock. Recorded on pt-igb.11.
func attachExisting(ctx context.Context, stdout io.Writer, in flow.JobInput, wfID string) int {
	if err := ensureClientDatabase(ctx); err != nil {
		if errors.Is(err, flow.ErrHostLocked) {
			return writeError(stdout, err.Error(), exitHostLocked)
		}
		return writeError(stdout, err.Error(), exitDatabase)
	}
	client, err := flow.NewClient(ctx)
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	defer func() { _ = flow.Shutdown(client, 5*time.Second) }()
	id := strings.TrimSpace(wfID)
	if id != "" {
		if handle, err := dbos.RetrieveWorkflow[flow.ScrapeResult](client, id); err == nil {
			return awaitJob(ctx, client, stdout, handle, in.Timeout.D())
		}
	}
	prefix := "ig:" + in.Handle + ":"
	workflows, err := dbos.ListWorkflows(client, dbos.WithFilterWorkflowIDPrefix(prefix), dbos.WithFilterSortDesc(), dbos.WithFilterLimit(20))
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	if id, ok := newestAttachableWorkflow(workflows); ok {
		handle, err := dbos.RetrieveWorkflow[flow.ScrapeResult](client, id)
		if err != nil {
			return writeError(stdout, err.Error(), exitDatabase)
		}
		return awaitJob(ctx, client, stdout, handle, in.Timeout.D())
	}
	return writeError(stdout, flow.ErrHostLocked.Error()+": no attachable job for handle "+in.Handle, exitHostLocked)
}

// newestAttachableWorkflow receives workflows in newest-first order. Child
// workflows do not represent a top-level scrape job. Once the newest parent is
// found, its state is authoritative: never scan past a newer terminal failure
// and return stale output from an older successful run.
func newestAttachableWorkflow(workflows []dbos.WorkflowStatus) (string, bool) {
	for _, wf := range workflows {
		if wf.ParentWorkflowID != "" {
			continue
		}
		switch wf.Status {
		case dbos.WorkflowStatusPending, dbos.WorkflowStatusEnqueued, dbos.WorkflowStatusSuccess:
			return wf.ID, true
		default:
			return "", false
		}
	}
	return "", false
}

// awaitJob blocks on handle.GetResult and formats the CLI JSON contract
// documented in helpText: {ok, workflowId, status, handle, profileJson,
// mediaDir, uniqueDir, analysisDir, counts, error?}.
func awaitJob(ctx context.Context, client dbos.Client, stdout io.Writer, handle dbos.WorkflowHandle[flow.ScrapeResult], timeout time.Duration) int {
	wfID := handle.GetWorkflowID()
	var result flow.ScrapeResult
	var getErr error
	if timeout > 0 {
		result, getErr = handle.GetResult(dbos.WithHandleTimeout(timeout + 30*time.Second))
	} else {
		result, getErr = handle.GetResult()
	}
	statusStr := "success"
	exitCode := exitOK
	var errMsg string
	if getErr != nil {
		statusStr = "error"
		errMsg = getErr.Error()
		exitCode = exitJobFailed
		if eventErr, evErr := dbos.GetEvent[string](client, wfID, flow.EventError, 100*time.Millisecond); evErr == nil && eventErr != "" {
			errMsg = eventErr
			if strings.HasPrefix(eventErr, "auth:") || strings.HasPrefix(eventErr, "llm:") || strings.HasPrefix(eventErr, "precondition:") {
				exitCode = exitPrecondition
			}
		}
	}
	if !result.OK && errMsg == "" {
		// Should not happen on a clean success, but keep the contract stable.
		result.OK = getErr == nil
	}
	out := map[string]any{
		"ok":                 result.OK,
		"workflowId":         wfID,
		"status":             statusStr,
		"handle":             result.Handle,
		"profileJson":        result.ProfileJSON,
		"mediaDir":           result.MediaDir,
		"uniqueDir":          result.UniqueDir,
		"analysisDir":        result.AnalysisDir,
		"knowledgeDir":       result.KnowledgeDir,
		"knowledgeIndex":     result.KnowledgeIndex,
		"knowledgeDocs":      result.KnowledgeDocs,
		"knowledgeInputHash": result.KnowledgeInputHash,
		"knowledgeChanged":   result.KnowledgeChanged,
		"skipped":            result.Skipped,
		"counts": map[string]int{
			"posts":           result.Counts.Posts,
			"reels":           result.Counts.Reels,
			"mediaUrls":       result.Counts.MediaURLs,
			"downloaded":      result.Counts.Downloaded,
			"unique":          result.Counts.Unique,
			"uniqueVideos":    result.Counts.UniqueVideos,
			"uniqueStills":    result.Counts.UniqueStills,
			"analyzed":        result.Counts.Analyzed,
			"knowledgeDocs":   result.Counts.KnowledgeDocs,
			"knowledgeAssets": result.Counts.KnowledgeAssets,
		},
	}
	if errMsg != "" {
		out["error"] = errMsg
	}
	_ = ctx
	return writeJSON(stdout, out, exitCode)
}

func ensureClientDatabase(ctx context.Context) error {
	url, err := flow.DatabaseURL()
	if err != nil {
		return err
	}
	if !strings.HasPrefix(url, "sqlite:") {
		return nil
	}
	path := strings.TrimPrefix(url, "sqlite:")
	path = strings.TrimPrefix(path, "//")
	if path == ":memory:" || strings.HasPrefix(path, "file:") {
		return nil
	}
	info, statErr := os.Stat(path)
	if statErr == nil && info.Size() > 0 {
		return nil
	}
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	host, release, err := flow.NewQuietHostContext(ctx)
	if err != nil {
		return err
	}
	defer release()
	if err := dbos.Launch(host); err != nil {
		_ = flow.Shutdown(host, 5*time.Second)
		return err
	}
	return flow.Shutdown(host, 5*time.Second)
}

func withClient(ctx context.Context, stdout io.Writer, fn func(dbos.Client) (any, error)) int {
	if err := ensureClientDatabase(ctx); err != nil {
		if errors.Is(err, flow.ErrHostLocked) {
			return writeError(stdout, err.Error(), exitHostLocked)
		}
		return writeError(stdout, err.Error(), exitDatabase)
	}
	client, err := flow.NewClient(ctx)
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	defer func() { _ = flow.Shutdown(client, 5*time.Second) }()
	value, err := fn(client)
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	return writeJSON(stdout, value, exitOK)
}

func statusCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("status", stderr)
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 1 {
		return writeError(stdout, "status requires <workflowId>", exitUsage)
	}
	id := fs.Arg(0)
	return withClient(ctx, stdout, func(client dbos.Client) (any, error) {
		workflows, err := dbos.ListWorkflows(client, dbos.WithFilterWorkflowIDPrefix(id), dbos.WithFilterLimit(20))
		if err != nil {
			return nil, err
		}
		var found *dbos.WorkflowStatus
		for i := range workflows {
			if workflows[i].ID == id {
				found = &workflows[i]
				break
			}
		}
		if found == nil {
			return nil, fmt.Errorf("workflow %q not found", id)
		}
		result := statusResult{WorkflowID: id, Status: strings.ToLower(string(found.Status)), CreatedAt: found.CreatedAt, UpdatedAt: found.UpdatedAt}
		if found.Error != nil {
			result.Error = found.Error.Error()
		}
		if stage, err := dbos.GetEvent[string](client, id, "stage", 20*time.Millisecond); err == nil {
			result.Stage = stage
		}
		if progress, err := dbos.GetEvent[progressResult](client, id, "progress", 20*time.Millisecond); err == nil {
			result.Progress = &progress
		}
		if eventErr, err := dbos.GetEvent[string](client, id, "error", 20*time.Millisecond); err == nil && eventErr != "" {
			result.Error = eventErr
		}
		return result, nil
	})
}

func parseStatus(value string) (dbos.WorkflowStatusType, bool) {
	switch strings.ToLower(value) {
	case "pending":
		return dbos.WorkflowStatusPending, true
	case "enqueued":
		return dbos.WorkflowStatusEnqueued, true
	case "success":
		return dbos.WorkflowStatusSuccess, true
	case "error":
		return dbos.WorkflowStatusError, true
	case "cancelled":
		return dbos.WorkflowStatusCancelled, true
	default:
		return "", false
	}
}

func listCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("list", stderr)
	status := fs.String("status", "", "workflow status")
	handle := fs.String("handle", "", "Instagram handle")
	limit := fs.Int("limit", 50, "maximum results")
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 0 || *limit < 1 {
		return writeError(stdout, "list takes only flags and --limit must be positive", exitUsage)
	}
	var statusFilter dbos.WorkflowStatusType
	if *status != "" {
		var ok bool
		statusFilter, ok = parseStatus(*status)
		if !ok {
			return writeError(stdout, "invalid --status: "+*status, exitUsage)
		}
	}
	return withClient(ctx, stdout, func(client dbos.Client) (any, error) {
		opts := []dbos.ListWorkflowsOption{dbos.WithFilterSortDesc(), dbos.WithFilterLimit(*limit)}
		if *handle != "" {
			opts = append(opts, dbos.WithFilterWorkflowIDPrefix("ig:"+strings.TrimPrefix(*handle, "@")+":"))
		}
		if *status != "" {
			opts = append(opts, dbos.WithFilterStatus(statusFilter))
		}
		workflows, err := dbos.ListWorkflows(client, opts...)
		if err != nil {
			return nil, err
		}
		results := make([]listResult, 0, len(workflows))
		for _, wf := range workflows {
			item := listResult{WorkflowID: wf.ID, Handle: handleFromID(wf.ID), Status: strings.ToLower(string(wf.Status)), CreatedAt: wf.CreatedAt}
			if !wf.CompletedAt.IsZero() {
				completed := wf.CompletedAt
				item.CompletedAt = &completed
			}
			results = append(results, item)
		}
		return results, nil
	})
}

func handleFromID(id string) string {
	parts := strings.Split(id, ":")
	if len(parts) >= 3 && parts[0] == "ig" {
		return parts[1]
	}
	return ""
}

func stepsCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("steps", stderr)
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 1 {
		return writeError(stdout, "steps requires <workflowId>", exitUsage)
	}
	id := fs.Arg(0)
	return withClient(ctx, stdout, func(client dbos.Client) (any, error) {
		steps, err := dbos.GetWorkflowSteps(client, id, dbos.WithStepsLoadOutput(false))
		if err != nil {
			return nil, err
		}
		results := make([]stepResult, 0, len(steps))
		for _, step := range steps {
			item := stepResult{StepID: step.StepID, Name: step.StepName, ChildWorkflowID: step.ChildWorkflowID}
			if step.Error != nil {
				item.Error = step.Error.Error()
			}
			results = append(results, item)
		}
		return results, nil
	})
}

func cancelCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("cancel", stderr)
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 1 {
		return writeError(stdout, "cancel requires <workflowId>", exitUsage)
	}
	id := fs.Arg(0)
	return withClient(ctx, stdout, func(client dbos.Client) (any, error) {
		if err := dbos.CancelWorkflow(client, id, dbos.WithCancelChildren()); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "workflowId": id, "status": "cancelled"}, nil
	})
}

func doctorCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("doctor", stderr)
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 0 {
		return writeError(stdout, "doctor takes no arguments", exitUsage)
	}
	// Bootstrap a brand-new SQLite system database, then use the client path.
	if err := ensureClientDatabase(ctx); err != nil {
		if errors.Is(err, flow.ErrHostLocked) {
			return writeError(stdout, err.Error(), exitHostLocked)
		}
		return writeError(stdout, err.Error(), exitDatabase)
	}
	client, err := flow.NewClient(ctx)
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	if err := flow.Shutdown(client, 5*time.Second); err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	report, err := flow.Doctor(ctx)
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	return writeJSON(stdout, doctorResult{DBPath: report.DatabasePath, JournalMode: report.JournalMode, AppName: report.AppName, AppVersion: report.ApplicationVersion, Pending: report.Pending, LockHeld: report.LockHolder.Held, GoVersion: report.GoVersion, DBOSVersion: report.DBOSVersion}, exitOK)
}

func gcCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("gc", stderr)
	olderThanRaw := fs.String("older-than", flow.DefaultGCRetentionString(), "retention duration")
	keepErrors := fs.Bool("keep-errors", false, "keep error workflows")
	dryRun := fs.Bool("dry-run", false, "show candidates only")
	if err := fs.Parse(args); err != nil {
		return writeError(stdout, err.Error(), exitUsage)
	}
	if fs.NArg() != 0 {
		return writeError(stdout, "gc takes only flags", exitUsage)
	}
	olderThan, err := parseRetention(*olderThanRaw)
	if err != nil || olderThan < 0 {
		return writeError(stdout, "invalid --older-than: "+*olderThanRaw, exitUsage)
	}
	if err := ensureClientDatabase(ctx); err != nil {
		if errors.Is(err, flow.ErrHostLocked) {
			return writeError(stdout, err.Error(), exitHostLocked)
		}
		return writeError(stdout, err.Error(), exitDatabase)
	}
	client, err := flow.NewClient(ctx)
	if err != nil {
		return writeError(stdout, err.Error(), exitDatabase)
	}
	defer func() { _ = flow.Shutdown(client, 5*time.Second) }()
	summary, err := flow.GC(ctx, client, flow.GCOptions{OlderThan: olderThan, KeepErrors: *keepErrors, DryRun: *dryRun})
	if err != nil {
		if errors.Is(err, flow.ErrHostLocked) {
			return writeError(stdout, err.Error(), exitHostLocked)
		}
		return writeError(stdout, err.Error(), exitDatabase)
	}
	return writeJSON(stdout, summary, exitOK)
}

func parseRetention(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasSuffix(raw, "d") {
		n, err := time.ParseDuration(strings.TrimSuffix(raw, "d") + "h")
		if err != nil {
			return 0, err
		}
		return n * 24, nil
	}
	return time.ParseDuration(raw)
}

func writeError(w io.Writer, message string, code int) int {
	return writeJSON(w, errorResult{OK: false, Error: message}, code)
}
func writeJSON(w io.Writer, value any, code int) int {
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, "encode JSON:", err)
		return exitDatabase
	}
	return code
}
