package flow

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// PreflightResult is the enriched outcome of the preflight stage.
// The richer fields feed the preflight event; OK is the single bool the
// workflow cares about.
type PreflightResult struct {
	OK    bool              `json:"ok"`
	Auth  *PreflightAuth    `json:"auth,omitempty"`
	LLM   *PreflightLLM     `json:"llm,omitempty"`
	Env   []PreflightEnvVar `json:"env,omitempty"`
	Tools []PreflightTool   `json:"tools,omitempty"`
}

// PreflightAuth summarises the Instagram cookie-jar check.
type PreflightAuth struct {
	OK        bool      `json:"ok"`
	User      string    `json:"user,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
}

// PreflightLLM summarises the Qwen ping.
type PreflightLLM struct {
	Skipped bool   `json:"skipped,omitempty"`
	OK      bool   `json:"ok"`
	Model   string `json:"model,omitempty"`
	BaseURL string `json:"baseUrl,omitempty"`
	Kind    string `json:"kind,omitempty"` // ok | missing-key | bad-key | bad-model | quota | unreachable
}

// PreflightEnvVar records whether a required env variable is set.
type PreflightEnvVar struct {
	Name string `json:"name"`
	Set  bool   `json:"set"`
}

// PreflightTool records whether a required tool is on PATH.
type PreflightTool struct {
	Name     string `json:"name"`
	Found    bool   `json:"found"`
	Path     string `json:"path,omitempty"`
	Required bool   `json:"required"`
}

// Hints surfaced in error events so humans know how to recover.
const (
	HintAuth = "run `patronum login` (or finish 2FA in the local Chrome), then resume the job (`patronum resume <id>`, or Resume in the dashboard)"
	HintLLM  = "run `patronum preflight`, fix the model settings in .env (LLM_API_KEY, LLM_BASE_URL, LLM_MODEL_*), then resume the job (`patronum resume <id>`, or Resume in the dashboard)"
	HintEnv  = "put IG_USER, IG_PASS, and LLM_API_KEY in .env or export them, then resume the job (`patronum resume <id>`, or Resume in the dashboard)"
)

func formatLLMPreflightMsg(kind, msg string) string {
	head := "LLM preflight failed"
	if kind != "" {
		head = fmt.Sprintf("LLM preflight failed (%s)", kind)
	}
	switch kind {
	case "missing-key", "bad-key", "quota":
		return fmt.Sprintf("%s: %s — %s", head, msg, HintLLM)
	default:
		// Parse/contract failures (pretty-printed JSON, empty stdout) are
		// not a missing key. Do not send the operator to .env.
		return fmt.Sprintf("%s: %s", head, msg)
	}
}

// Chrome cookie-jar constants.
const (
	// Relative path from repo root to the Chrome Cookies SQLite DB.
	relCookieJar = "data/chrome-profile/Default/Cookies"

	// Windows FILETIME epoch offset: microseconds between 1601-01-01 and
	// 1970-01-01 (Unix epoch).
	windowsEpochOffsetMicros = 11644473600 * 1_000_000
)

// chromeCookieExpiry converts a Chrome expires_utc (Windows FILETIME-style
// microseconds since 1601-01-01) to a Go time.Time. A zero or negative
// result means session-only (no persistent expiry).
func chromeCookieExpiry(expiresUtc int64) time.Time {
	if expiresUtc <= 0 {
		return time.Time{}
	}
	unixMicro := expiresUtc - windowsEpochOffsetMicros
	return time.UnixMicro(unixMicro)
}

// ---------- env checks ----------

// requiredEnvKeys lists the env variables whose absence is a hard stop.
// The API key group is |-separated: at least one must be present.
var requiredEnvKeys = [][]string{
	{"IG_USER"},
	{"IG_PASS"},
	{"LLM_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_API_KEY"},
}

// checkEnv verifies that every required env variable (or at least one per
// group) is set. It returns the list and a non-nil error naming the
// missing variables. Values are never inspected beyond presence.
func checkEnv() ([]PreflightEnvVar, error) {
	var out []PreflightEnvVar
	var missing []string
	for _, group := range requiredEnvKeys {
		found := false
		for _, k := range group {
			set := os.Getenv(k) != ""
			out = append(out, PreflightEnvVar{Name: k, Set: set})
			if set {
				found = true
			}
		}
		if !found {
			missing = append(missing, strings.Join(group, "|"))
		}
	}
	if len(missing) > 0 {
		return out, fmt.Errorf("missing env: %s", strings.Join(missing, ", "))
	}
	return out, nil
}

// ---------- LLM ping ----------

// runLLMPing shells out to `bun src/cmd/cli.ts preflight` (or the
// IGFLOW_PREFLIGHT_CMD override) and classifies the tail-JSON result.
// Returns PreflightLLM and a non-nil error on failure.
func runLLMPing(ctx context.Context, wfID string) (PreflightLLM, error) {
	res, err := RunCLI(ctx, CLISpec{
		Name:        "preflight-llm",
		Argv:        []string{"bun", "src/cmd/cli.ts", "preflight"},
		EnvOverride: EnvPreflightCmd,
		WorkflowID:  wfID,
	})
	llm := PreflightLLM{}
	if res.JSON != nil {
		if sub, ok := res.JSON["llm"].(map[string]any); ok {
			if v, ok := sub["model"].(string); ok {
				llm.Model = v
			}
			if v, ok := sub["baseUrl"].(string); ok {
				llm.BaseURL = v
			}
			if v, ok := sub["kind"].(string); ok {
				llm.Kind = v
			}
		}
		// Fallback: top-level kind
		if llm.Kind == "" {
			if v, ok := res.JSON["kind"].(string); ok {
				llm.Kind = v
			}
		}
	}

	if err != nil {
		var cliErr *CLIError
		if errors.As(err, &cliErr) {
			if llm.Kind == "" {
				llm.Kind = cliErr.Code
			}
		}
		llm.OK = false
		return llm, err
	}
	llm.OK = true
	llm.Kind = "ok"
	return llm, nil
}

// ---------- cookie-jar check ----------

// checkCookieJar verifies that the Chrome cookie jar at
// data/chrome-profile/Default/Cookies contains sessionid and ds_user_id
// for .instagram.com with a future expires_utc. The DB is opened
// read-only on a copy (Chrome holds a write lock on the live file).
//
// cookieJarPath overrides the default path (for tests).
func checkCookieJar(cookieJarPath string) (PreflightAuth, error) {
	if cookieJarPath == "" {
		root, err := HomeDir()
		if err != nil {
			return PreflightAuth{}, fmt.Errorf("cookie check: %w", err)
		}
		cookieJarPath = filepath.Join(root, relCookieJar)
		if profile := os.Getenv("PATRONUM_CHROME_PROFILE_DIR"); profile != "" {
			if !filepath.IsAbs(profile) {
				profile = filepath.Join(root, profile)
			}
			cookieJarPath = filepath.Join(profile, "Default", "Cookies")
		}
	}

	// Copy the file so we don't fight Chrome's WAL lock.
	tmpFile, err := copyToTemp(cookieJarPath)
	if err != nil {
		return PreflightAuth{}, fmt.Errorf("cookie check: %w", err)
	}
	defer os.Remove(tmpFile)

	db, err := sql.Open("sqlite", tmpFile+"?mode=ro&_pragma=journal_mode(off)")
	if err != nil {
		return PreflightAuth{}, fmt.Errorf("cookie check: open db: %w", err)
	}
	defer db.Close()

	now := time.Now()
	nowChrome := (now.UnixMicro()) + windowsEpochOffsetMicros

	// Query: sessionid and ds_user_id for .instagram.com with future expiry.
	type cookieRow struct {
		name      string
		expiresAt int64
	}
	needed := map[string]cookieRow{}
	rows, err := db.Query(
		`SELECT name, expires_utc FROM cookies
		 WHERE host_key IN ('.instagram.com', 'instagram.com')
		   AND name IN ('sessionid', 'ds_user_id')
		   AND expires_utc > ?`,
		nowChrome,
	)
	if err != nil {
		return PreflightAuth{}, fmt.Errorf("cookie check: query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var expiresUtc int64
		if err := rows.Scan(&name, &expiresUtc); err != nil {
			return PreflightAuth{}, fmt.Errorf("cookie check: scan: %w", err)
		}
		needed[name] = cookieRow{name: name, expiresAt: expiresUtc}
	}
	if err := rows.Err(); err != nil {
		return PreflightAuth{}, fmt.Errorf("cookie check: rows: %w", err)
	}

	sid, hasSid := needed["sessionid"]
	_, hasDsUser := needed["ds_user_id"]

	if !hasSid || !hasDsUser {
		var absent []string
		if !hasSid {
			absent = append(absent, "sessionid")
		}
		if !hasDsUser {
			absent = append(absent, "ds_user_id")
		}
		return PreflightAuth{OK: false}, fmt.Errorf(
			"cookie check: missing or expired cookies: %s",
			strings.Join(absent, ", "),
		)
	}

	return PreflightAuth{
		OK:        true,
		ExpiresAt: chromeCookieExpiry(sid.expiresAt),
	}, nil
}

// copyToTemp copies src to a new temp file and returns its path. The
// caller must os.Remove it.
func copyToTemp(src string) (string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()

	tmp, err := os.CreateTemp("", "igflow-cookies-*.sqlite")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return "", err
	}
	return tmpPath, nil
}

// ---------- tool checks ----------

// requiredTools lists the tools every run needs. ffmpeg/ffprobe are
// conditional on the enabled media stages.
var requiredTools = []string{"bun", "go"}
var optionalMediaTools = []string{"ffmpeg", "ffprobe"}

// checkTools verifies exec.LookPath for each collection tool.
func checkTools(skipUnique, _ bool) ([]PreflightTool, error) {
	var out []PreflightTool
	var missing []string

	for _, name := range requiredTools {
		path, err := exec.LookPath(name)
		found := err == nil
		out = append(out, PreflightTool{Name: name, Found: found, Path: path, Required: true})
		if !found {
			missing = append(missing, name)
		}
	}

	for _, name := range optionalMediaTools {
		path, err := exec.LookPath(name)
		found := err == nil
		required := !skipUnique
		out = append(out, PreflightTool{Name: name, Found: found, Path: path, Required: required})
		if !found && required {
			missing = append(missing, name)
		}
	}

	if len(missing) > 0 {
		return out, fmt.Errorf("missing tools: %s", strings.Join(missing, ", "))
	}
	return out, nil
}

// ---------- composite preflight ----------

// RunPreflight executes all checks in sequence. The first failure returns
// immediately with a classified error suitable for the workflow's
// failStage handler. cookieJarPath is empty in production (auto-resolved
// from RepoRoot); tests pass a fixture path.
func RunPreflight(ctx context.Context, in JobInput, wfID string, cookieJarPath string) (PreflightResult, error) {
	result := PreflightResult{}

	// 1. Env check.
	envVars, envErr := checkEnv()
	result.Env = envVars
	if envErr != nil {
		return result, &CLIError{
			Stage:     StagePreflight,
			Retryable: false,
			Code:      "precondition",
			Msg:       envErr.Error() + " — " + HintEnv,
		}
	}

	// 2. LLM ping (via bun preflight or IGFLOW_PREFLIGHT_CMD).
	if in.SkipLLMPreflight {
		result.LLM = &PreflightLLM{Skipped: true, Kind: "skipped"}
	} else {
		llm, llmErr := runLLMPing(ctx, wfID)
		result.LLM = &llm
		if llmErr != nil {
			// Ensure the error carries code "llm" regardless of exec classification.
			var cliErr *CLIError
			if errors.As(llmErr, &cliErr) {
				if cliErr.Code == "" {
					cliErr.Code = "llm"
				}
				cliErr.Msg = formatLLMPreflightMsg(llm.Kind, cliErr.Msg)
				cliErr.Retryable = false
				return result, cliErr
			}
			return result, &CLIError{
				Stage:     StagePreflight,
				Retryable: false,
				Code:      "llm",
				Msg:       formatLLMPreflightMsg(llm.Kind, llmErr.Error()),
			}
		}
	}

	// 3. Cookie-jar check (Instagram auth).
	auth, authErr := checkCookieJar(cookieJarPath)
	result.Auth = &auth
	if authErr != nil {
		return result, &CLIError{
			Stage:     StagePreflight,
			Retryable: false,
			Code:      "auth",
			Msg:       fmt.Sprintf("%v — %s", authErr, HintAuth),
		}
	}

	// 4. Tool checks.
	tools, toolErr := checkTools(in.SkipUnique, in.SkipKB)
	result.Tools = tools
	if toolErr != nil {
		return result, &CLIError{
			Stage:     StagePreflight,
			Retryable: false,
			Code:      "precondition",
			Msg:       toolErr.Error(),
		}
	}

	result.OK = true
	return result, nil
}
