package flow

import (
	"bytes"
	"context"
	"encoding/gob"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

func init() {
	gob.Register(&CLIError{})
}

// Environment variable names that override each stage's default argv. When
// set, the value is shell-word-split (see splitCommand) and used verbatim
// instead of CLISpec.Argv. Tests use these to substitute fixture scripts.
const (
	EnvScrapeCmd    = "IGFLOW_SCRAPE_CMD"
	EnvIGDLCmd      = "IGFLOW_IGDL_CMD"
	EnvIGUniqueCmd  = "IGFLOW_IGUNIQUE_CMD"
	EnvIGAnalyzeCmd = "IGFLOW_IGANALYZE_CMD"
	EnvVerifyCmd    = "IGFLOW_VERIFY_CMD"
	EnvPreflightCmd = "IGFLOW_PREFLIGHT_CMD"
)

// Exit codes shared with the TypeScript CLIs. Kept in one place so the
// exec.go classifier and the CLI never drift.
const (
	// ExitOK is a successful CLI run (exit 0). exec.go still requires the
	// tail JSON to declare {"ok":true}; a bare zero exit is not enough.
	ExitOK = 0
	// ExitAuthFail is the TypeScript exit code for a login-wall or missing
	// cookie-jar precondition. Maps to CLIError{Retryable:false, Code:"auth"}.
	ExitAuthFail = 3
	// ExitLLMFail is the TypeScript exit code for a Qwen/LLM outage
	// (missing key, base URL unreachable, quota). Maps to
	// CLIError{Retryable:false, Code:"llm"}.
	ExitLLMFail = 4
)

// Grace period between SIGTERM and SIGKILL when a step is cancelled or
// times out.
const cliKillGrace = 10 * time.Second

// CLISpec describes one subprocess step. Callers set at minimum Name and
// either Argv or an EnvOverride whose environment variable is set.
type CLISpec struct {
	// Name is the stage tag ("scrape", "igdl", "igunique", "iganalyze",
	// "verify", "preflight"). Used in log paths, stderr prefixes, and
	// CLIError.Stage.
	Name string
	// Argv is the default command and its arguments. Ignored when
	// EnvOverride names an environment variable that is set.
	Argv []string
	// Dir is the subprocess working directory. Empty defaults to
	// RepoRoot(); most callers rely on the default.
	Dir string
	// WorkflowID names the per-run log directory. When LogPath is empty
	// the log file is <HomeDir>/data/dbos/logs/<WorkflowID>/<Name>.log.
	// Workflows should compute this via dbos.GetWorkflowID before calling
	// RunCLI.
	WorkflowID string
	// LogPath, when non-empty, overrides the derived per-run log path.
	// Convenient for tests that want the log inside t.TempDir().
	LogPath string
	// Timeout, when > 0, applies a per-call deadline on top of ctx.
	// Cancellation drives the process-group kill (SIGTERM then SIGKILL).
	Timeout time.Duration
	// EnvOverride names an environment variable (e.g. "IGFLOW_SCRAPE_CMD")
	// whose value replaces Argv when the variable is set. Empty disables
	// the test seam.
	EnvOverride string
	// Env is appended after os.Environ() when the subprocess is spawned.
	// Nil is the common case: the CLIs read .env themselves.
	Env []string
}

// CLIResult is the classified outcome of a subprocess step. It always
// carries the resolved Argv, the log-file path (so callers can attach
// tails to error reports), and, on success, the parsed tail-JSON object.
type CLIResult struct {
	Stage    string         `json:"stage"`
	ExitCode int            `json:"exit_code"`
	Argv     []string       `json:"argv"`
	LogPath  string         `json:"log_path"`
	JSON     map[string]any `json:"json,omitempty"`
	Duration time.Duration  `json:"duration"`
}

// OK reports whether the tail JSON declared success (ok == true). A bare
// exit-0 with no tail JSON is not "OK": the CLI contract requires the
// JSON marker so exec.go can distinguish a real success from a silent
// crash.
func (r CLIResult) OK() bool {
	v, ok := r.JSON["ok"].(bool)
	return ok && v
}

// String returns a JSON tail field as a string, or "" if absent or not a
// string. Handy for pulling {"path": "..."} out of a scrape result.
func (r CLIResult) String(key string) string {
	if r.JSON == nil {
		return ""
	}
	if v, ok := r.JSON[key].(string); ok {
		return v
	}
	return ""
}

// Int returns a JSON tail field as an int. JSON numbers are decoded as
// float64 by encoding/json; this method rounds to int for the count
// fields the pipeline uses. Returns 0 if the key is absent or not a
// number.
func (r CLIResult) Int(key string) int {
	if r.JSON == nil {
		return 0
	}
	switch v := r.JSON[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	}
	return 0
}

// ErrorMsg returns the tail JSON's "error" field, or "" if missing. Used
// by callers to surface CLI-declared failure reasons in job status.
func (r CLIResult) ErrorMsg() string {
	return r.String("error")
}

// CLIError is the typed error returned by RunCLI when a subprocess step
// fails. Retryable drives dbos.WithStepRetryPredicate; Code carries
// preflight-critical categories (auth, llm) surfaced by the TS exit-code
// contract (3 = auth, 4 = llm) or by the tail JSON's error field.
type CLIError struct {
	Stage     string
	ExitCode  int
	Retryable bool
	Code      string // "auth" | "llm" | ""
	Msg       string
	// LogPath is the on-disk tee log for the failed run.
	LogPath string
	// Argv is the resolved command (after EnvOverride expansion).
	Argv []string
	// Cause carries the underlying context/exec error when relevant
	// (context.Canceled, context.DeadlineExceeded, exec.ExitError, ...).
	Cause error
}

// Error renders the CLIError as a human-readable string.
func (e *CLIError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "flow: %s cli failed (exit=%d retryable=%t", e.Stage, e.ExitCode, e.Retryable)
	if e.Code != "" {
		fmt.Fprintf(&b, " code=%s", e.Code)
	}
	b.WriteString(")")
	if e.Msg != "" {
		fmt.Fprintf(&b, ": %s", e.Msg)
	}
	if e.LogPath != "" {
		fmt.Fprintf(&b, " [log: %s]", e.LogPath)
	}
	return b.String()
}

// Unwrap exposes the underlying cause (exec.ExitError, context.Canceled,
// context.DeadlineExceeded, syscall errors) so errors.Is works as
// callers expect.
func (e *CLIError) Unwrap() error { return e.Cause }

// RetryPredicate is the classifier for dbos.WithStepRetryPredicate.
// Non-CLIError errors default to retryable so transient DBOS or context
// issues still exercise backoff; CLIError obeys its own Retryable field.
func RetryPredicate(err error) bool {
	if err == nil {
		return false
	}
	var cli *CLIError
	if errors.As(err, &cli) {
		return cli.Retryable
	}
	return true
}

// RunCLI runs a subprocess step. Behavior:
//
//   - argv resolution: os.Getenv(spec.EnvOverride), shell-word-split if set;
//     otherwise spec.Argv.
//   - working directory: spec.Dir, or RepoRoot() when empty.
//   - env: os.Environ() plus spec.Env.
//   - process group: Setpgid=true so ctx cancellation or spec.Timeout can
//     SIGTERM the whole group and SIGKILL after cliKillGrace.
//   - logging: stdout+stderr tee'd to <log> and to os.Stderr with the
//     timestamp, stage and stream context. Attempts append to the log;
//     configured secrets and authentication tokens are redacted.
//   - result: the last non-empty line on stdout that parses as a JSON
//     object becomes CLIResult.JSON. Classification follows the epic's
//     mapping table (see package-level docs and CLIError).
func RunCLI(ctx context.Context, spec CLISpec) (res CLIResult, retErr error) {
	res = CLIResult{Stage: spec.Name, ExitCode: -1}
	argv, err := resolveArgv(spec)
	if err != nil {
		return res, err
	}
	res.Argv = argv

	dir := spec.Dir
	if dir == "" {
		root, rerr := RepoRoot()
		if rerr != nil {
			return res, fmt.Errorf("flow.RunCLI: %s: %w", spec.Name, rerr)
		}
		dir = root
	}

	logPath, err := resolveLogPath(spec)
	if err != nil {
		return res, err
	}
	res.LogPath = logPath
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return res, fmt.Errorf("flow.RunCLI: mkdir log dir: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return res, fmt.Errorf("flow.RunCLI: open log %s: %w", logPath, err)
	}
	defer logFile.Close()

	runCtx := ctx
	var cancel context.CancelFunc
	if spec.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, spec.Timeout)
		defer cancel()
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	if len(spec.Env) == 0 {
		cmd.Env = os.Environ()
	} else {
		cmd.Env = append(os.Environ(), spec.Env...)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	logger := &stageLog{file: logFile, mirror: os.Stderr, name: spec.Name, redact: logRedactor(cmd.Env)}
	start := time.Now()
	if err := logger.write("lifecycle", "event=start"); err != nil {
		return res, err
	}
	defer func() {
		res.Duration = time.Since(start)
		var cliErr *CLIError
		if errors.As(retErr, &cliErr) {
			cliErr.Msg = logger.redact(cliErr.Msg)
			cliErr.Argv = append([]string(nil), cliErr.Argv...)
			for i := range cliErr.Argv {
				cliErr.Argv[i] = logger.redact(cliErr.Argv[i])
			}
		}
		for i := range res.Argv {
			res.Argv[i] = logger.redact(res.Argv[i])
		}
		event := "success"
		if retErr != nil {
			event = "failure"
		}
		if errors.Is(retErr, context.Canceled) {
			event = "canceled"
		}
		if errors.Is(retErr, context.DeadlineExceeded) {
			event = "timeout"
		}
		message := fmt.Sprintf("event=%s exit_code=%d duration_ms=%d", event, res.ExitCode, res.Duration.Milliseconds())
		if retErr != nil {
			message += " error=" + retErr.Error()
		}
		if err := logger.write("lifecycle", message); err != nil {
			retErr = errors.Join(retErr, fmt.Errorf("write stage log: %w", err))
		}
		if err := logFile.Sync(); err != nil {
			retErr = errors.Join(retErr, fmt.Errorf("sync stage log: %w", err))
		}
	}()
	tailBuf := &lastJSONLine{}
	stdout := &stageStream{log: logger, name: "stdout", tail: tailBuf}
	stderr := &stageStream{log: logger, name: "stderr"}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		return res, &CLIError{
			Stage:     spec.Name,
			ExitCode:  -1,
			Retryable: true,
			Msg:       fmt.Sprintf("start: %v", err),
			LogPath:   logPath,
			Argv:      argv,
			Cause:     err,
		}
	}
	pid := cmd.Process.Pid

	// Cancellation watcher: SIGTERM the process group on ctx cancel or
	// spec.Timeout expiry; escalate to SIGKILL after cliKillGrace.
	waitDone := make(chan struct{})
	go func() {
		select {
		case <-runCtx.Done():
			killProcessGroup(pid, syscall.SIGTERM)
			timer := time.NewTimer(cliKillGrace)
			defer timer.Stop()
			select {
			case <-waitDone:
			case <-timer.C:
				killProcessGroup(pid, syscall.SIGKILL)
			}
		case <-waitDone:
		}
	}()

	waitErr := cmd.Wait()
	close(waitDone)
	waitErr = errors.Join(waitErr, stdout.flush(), stderr.flush())
	res.Duration = time.Since(start)

	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}

	if line := tailBuf.take(); line != nil {
		var obj map[string]any
		if json.Unmarshal(line, &obj) == nil {
			res.JSON = obj
		}
	}

	// Cancellation / timeout: classify BEFORE inspecting waitErr, because
	// exec surfaces the signal as a *ExitError with a negative code.
	if ctxErr := runCtx.Err(); ctxErr != nil {
		code := "canceled"
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			code = "timeout"
		}
		return res, &CLIError{
			Stage:     spec.Name,
			ExitCode:  res.ExitCode,
			Retryable: true,
			Msg:       code,
			LogPath:   logPath,
			Argv:      argv,
			Cause:     ctxErr,
		}
	}

	if waitErr != nil && res.ExitCode == ExitOK {
		return res, &CLIError{Stage: spec.Name, ExitCode: res.ExitCode, Retryable: true, Msg: "output capture failed", LogPath: logPath, Cause: waitErr}
	}
	return classify(res, waitErr, argv)
}

// classify applies the mapping table from the epic DESIGN:
//
//	exit 0 + ok:true                       -> success (nil error)
//	exit 0 + no ok:true                    -> non-retryable (contract bug)
//	JSON failure + exit 1 + retryable:true -> retryable, except auth/llm
//	other JSON failures                   -> non-retryable
//	TS exit 3                              -> auth,  non-retryable
//	TS exit 4                              -> llm,   non-retryable
//	json.error=="auth"                     -> auth,  non-retryable
//	json.error=="llm"                      -> llm,   non-retryable
//	exit != 0, no JSON line                -> retryable
func classify(res CLIResult, waitErr error, argv []string) (CLIResult, error) {
	stage := res.Stage
	code := ""
	if e := res.ErrorMsg(); e == "auth" || e == "llm" {
		code = e
	}
	// TS exit-code channel wins over JSON when both are present: exit 3/4
	// is emitted only when the CLI is certain about the category.
	switch res.ExitCode {
	case ExitAuthFail:
		return res, &CLIError{
			Stage:     stage,
			ExitCode:  res.ExitCode,
			Retryable: false,
			Code:      "auth",
			Msg:       firstNonEmpty(res.ErrorMsg(), "auth precondition failed"),
			LogPath:   res.LogPath,
			Argv:      argv,
			Cause:     waitErr,
		}
	case ExitLLMFail:
		return res, &CLIError{
			Stage:     stage,
			ExitCode:  res.ExitCode,
			Retryable: false,
			Code:      "llm",
			Msg:       firstNonEmpty(res.ErrorMsg(), "llm precondition failed"),
			LogPath:   res.LogPath,
			Argv:      argv,
			Cause:     waitErr,
		}
	}

	if res.JSON != nil {
		if res.OK() && res.ExitCode == ExitOK {
			return res, nil
		}
		// Structured failures are terminal unless the CLI explicitly identifies
		// a transient exit. Authentication and provider markers remain terminal.
		retryable, _ := res.JSON["retryable"].(bool)
		retryable = retryable && res.ExitCode == 1 && code == ""
		return res, &CLIError{
			Stage:     stage,
			ExitCode:  res.ExitCode,
			Retryable: retryable,
			Code:      code,
			Msg:       firstNonEmpty(res.ErrorMsg(), "cli reported ok=false"),
			LogPath:   res.LogPath,
			Argv:      argv,
			Cause:     waitErr,
		}
	}

	if res.ExitCode == ExitOK {
		// Exit 0 but no JSON marker: the CLI is out of contract. Do not
		// retry — this is a deploy bug, not a flake.
		return res, &CLIError{
			Stage:     stage,
			ExitCode:  res.ExitCode,
			Retryable: false,
			Msg:       "exit 0 but no tail JSON object",
			LogPath:   res.LogPath,
			Argv:      argv,
			Cause:     waitErr,
		}
	}

	// Crash, kill, or non-zero exit with no JSON: retryable.
	return res, &CLIError{
		Stage:     stage,
		ExitCode:  res.ExitCode,
		Retryable: true,
		Msg:       "exit non-zero with no tail JSON",
		LogPath:   res.LogPath,
		Argv:      argv,
		Cause:     waitErr,
	}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// resolveArgv chooses the effective argv: env override wins when set.
func resolveArgv(spec CLISpec) ([]string, error) {
	if spec.EnvOverride != "" {
		if v := strings.TrimSpace(os.Getenv(spec.EnvOverride)); v != "" {
			parts, err := splitCommand(v)
			if err != nil {
				return nil, fmt.Errorf("flow.RunCLI: parse %s: %w", spec.EnvOverride, err)
			}
			if len(parts) == 0 {
				return nil, fmt.Errorf("flow.RunCLI: %s is empty after split", spec.EnvOverride)
			}
			return parts, nil
		}
	}
	if len(spec.Argv) == 0 {
		return nil, fmt.Errorf("flow.RunCLI: %s: empty Argv and no %s override", spec.Name, spec.EnvOverride)
	}
	out := make([]string, len(spec.Argv))
	copy(out, spec.Argv)
	return out, nil
}

// resolveLogPath returns spec.LogPath when set, otherwise
// <HomeDir>/data/dbos/logs/<WorkflowID>/<Name>.log. Falls back to a
// "unassigned" bucket when WorkflowID is missing so an accidental call
// still produces a discoverable log rather than crashing.
func resolveLogPath(spec CLISpec) (string, error) {
	if spec.LogPath != "" {
		return spec.LogPath, nil
	}
	root, err := HomeDir()
	if err != nil {
		return "", err
	}
	wf := spec.WorkflowID
	if wf == "" {
		wf = "unassigned"
	}
	name := spec.Name
	if name == "" {
		name = "step"
	}
	return filepath.Join(root, relDataDir, "logs", wf, name+".log"), nil
}

// splitCommand is a small POSIX-ish shell-word splitter. Handles
// single quotes ('literal, no escapes'), double quotes ("with \ and \"
// escapes"), and backslash escapes outside quotes. Enough for
// IGFLOW_*_CMD test seams like `bash testdata/ok.sh` or `env FOO=bar
// bash "spaced dir/ok.sh"`.
func splitCommand(s string) ([]string, error) {
	var (
		out      []string
		cur      strings.Builder
		inSingle bool
		inDouble bool
		escaped  bool
		started  bool
	)
	flush := func() {
		if started {
			out = append(out, cur.String())
			cur.Reset()
			started = false
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if escaped {
			cur.WriteByte(c)
			started = true
			escaped = false
			continue
		}
		if inSingle {
			if c == '\'' {
				inSingle = false
				continue
			}
			cur.WriteByte(c)
			started = true
			continue
		}
		if inDouble {
			if c == '\\' {
				if i+1 < len(s) {
					next := s[i+1]
					if next == '"' || next == '\\' || next == '$' || next == '`' {
						cur.WriteByte(next)
						started = true
						i++
						continue
					}
				}
				cur.WriteByte(c)
				started = true
				continue
			}
			if c == '"' {
				inDouble = false
				continue
			}
			cur.WriteByte(c)
			started = true
			continue
		}
		switch c {
		case ' ', '\t', '\n':
			flush()
		case '\'':
			inSingle = true
			started = true
		case '"':
			inDouble = true
			started = true
		case '\\':
			escaped = true
		default:
			cur.WriteByte(c)
			started = true
		}
	}
	if inSingle || inDouble {
		return nil, errors.New("unterminated quote")
	}
	if escaped {
		return nil, errors.New("dangling backslash")
	}
	flush()
	return out, nil
}

// lastJSONLine remembers the most-recent stdout JSON object, including
// pretty-printed objects that span lines.
type lastJSONLine struct {
	mu    sync.Mutex
	acc   []byte
	depth int
	inStr bool
	esc   bool
}

func (l *lastJSONLine) set(b []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.depth == 0 {
		trimmed := bytes.TrimSpace(b)
		if len(trimmed) == 0 || trimmed[0] != '{' {
			return
		}
		l.acc = append(l.acc[:0], trimmed...)
		l.depth, l.inStr, l.esc = braceScan(trimmed, 0, false, false)
		return
	}
	l.acc = append(l.acc, '\n')
	l.acc = append(l.acc, b...)
	l.depth, l.inStr, l.esc = braceScan(b, l.depth, l.inStr, l.esc)
}

func (l *lastJSONLine) take() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.acc
	l.acc = nil
	l.depth = 0
	l.inStr = false
	l.esc = false
	return out
}

// braceScan updates object-brace depth, ignoring braces inside JSON strings.
func braceScan(b []byte, depth int, inStr, esc bool) (int, bool, bool) {
	for _, c := range b {
		if inStr {
			if esc {
				esc = false
				continue
			}
			if c == '\\' {
				esc = true
				continue
			}
			if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			if depth > 0 {
				depth--
			}
		}
	}
	return depth, inStr, esc
}

// killProcessGroup best-effort sends sig to the negative pid (process
// group). Errors are swallowed: the process may already be gone.
func killProcessGroup(pid int, sig syscall.Signal) {
	_ = syscall.Kill(-pid, sig)
}

// Per-stage retry policies from the epic DESIGN. Callers assemble them
// into dbos.RunAsStep options; they are exported so future stage beads
// share one source of truth.
var (
	// ScrapeRetryPolicy: bun scrape-profile — 2 retries, 30s base, 5m cap.
	ScrapeRetryPolicy = RetryPolicy{MaxRetries: 2, BaseInterval: 30 * time.Second, MaxInterval: 5 * time.Minute}
	// IGDLRetryPolicy: go run ./cmd/igdl — 3 retries.
	IGDLRetryPolicy = RetryPolicy{MaxRetries: 3, BaseInterval: 30 * time.Second, MaxInterval: 5 * time.Minute}
	// IGUniqueRetryPolicy: go run ./cmd/igunique — 1 retry.
	IGUniqueRetryPolicy = RetryPolicy{MaxRetries: 1, BaseInterval: 30 * time.Second, MaxInterval: 5 * time.Minute}
	// IGAnalyzeRetryPolicy: go run ./cmd/iganalyze — 2 retries.
	IGAnalyzeRetryPolicy = RetryPolicy{MaxRetries: 2, BaseInterval: 30 * time.Second, MaxInterval: 5 * time.Minute}
)

// RetryPolicy bundles the retry knobs a stage step passes to DBOS. Kept
// as a plain struct (not dbos.StepOption) so unit tests and the CLI can
// inspect the numbers without importing dbos.
type RetryPolicy struct {
	MaxRetries   int
	BaseInterval time.Duration
	MaxInterval  time.Duration
}
