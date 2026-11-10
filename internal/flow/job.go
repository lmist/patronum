// Package flow: ScrapeJob durable workflow and stage seam.
//
// pt-igb.6 wires the workflow tree from the epic DESIGN:
//
//	ScrapeJob (queue ig-jobs, WithDeduplicationID(handle))
//	  ├─ preflight (skippable via NoPreflight)
//	  ├─ scrape    (ig-scrape queue, GlobalConcurrency 1)
//	  ├─ verify
//	  ├─ download  (ig-download queue, WorkerConcurrency 8; skippable)
//	  ├─ unique    (skippable)
//	  └─ analyze   (ig-analyze queue, WorkerConcurrency 4; skippable)
//
// Stage bodies live behind the Stages seam so pt-igb.8/.9/.10 can drop in
// real implementations without touching the workflow function. The stock
// wiring runs each stage as a subprocess step via exec.RunCLI, honoring
// the IGFLOW_*_CMD env overrides so tests can swap in fixture scripts.
package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

// JobInputVersion is the current JobInput schema version. Bumped only when
// a field's meaning changes; adding optional fields is not a bump.
const JobInputVersion = 1

// Queue names. Registered once by RegisterAll before Launch.
const (
	QueueIGJobs     = "ig-jobs"
	QueueIGScrape   = "ig-scrape"
	QueueIGDownload = "ig-download"
	QueueIGAnalyze  = "ig-analyze"
)

// Stage names emitted as the "stage" event and used as step names.
const (
	StagePreflight = "preflight"
	StageScrape    = "scrape"
	StageVerify    = "verify"
	StageDownload  = "download"
	StageUnique    = "unique"
	StageAnalyze   = "analyze"
	StageKnowledge = "knowledge"
	StageDone      = "done"
)

// Event names. Kept in one place so status readers stay in sync.
const (
	EventStage    = "stage"
	EventProgress = "progress"
	EventError    = "error"
	StreamLog     = "log"
)

// DefaultTimeout applies when JobInput.Timeout is zero.
const DefaultTimeout = 6 * time.Hour

// Duration is a portable time.Duration for JobInput. It marshals as a
// Go duration string ("6h", "45m") so JobInput JSON round-trips across
// languages (rhai, TS, Go) without depending on int64 nanoseconds.
type Duration time.Duration

// D is the underlying time.Duration.
func (d Duration) D() time.Duration { return time.Duration(d) }

// String renders as time.Duration.String().
func (d Duration) String() string { return time.Duration(d).String() }

// MarshalJSON writes a duration string.
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// UnmarshalJSON accepts either a duration string ("6h") or a JSON number
// of nanoseconds (for backwards tolerance).
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		v, perr := time.ParseDuration(s)
		if perr != nil {
			return fmt.Errorf("flow.Duration: %w", perr)
		}
		*d = Duration(v)
		return nil
	}
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return fmt.Errorf("flow.Duration: expected string or int64, got %s", string(b))
	}
	*d = Duration(time.Duration(n))
	return nil
}

// JobInput is the portable, versioned input for ScrapeJob. Keep in sync
// with the epic DESIGN "JobInput" block and with rhai/TS callers.
type JobInput struct {
	V                int      `json:"v"`
	Handle           string   `json:"handle"`
	ProfileURL       string   `json:"profileURL,omitempty"`
	Max              int      `json:"max"`
	Detail           bool     `json:"detail"`
	SkipReels        bool     `json:"skipReels"`
	ForceLogin       bool     `json:"forceLogin"`
	Fresh            bool     `json:"fresh"`
	SkipDownload     bool     `json:"skipDownload"`
	SkipUnique       bool     `json:"skipUnique"`
	SkipAnalyze      bool     `json:"skipAnalyze"`
	SkipKB           bool     `json:"skipKB,omitempty"`
	DLWorkers        int      `json:"dlWorkers"`
	AnalyzeWorkers   int      `json:"analyzeWorkers"`
	PerShortcode     bool     `json:"perShortcode"`
	AllFrames        bool     `json:"allFrames,omitempty"`
	ScrollRounds     int      `json:"scrollRounds"`
	Timeout          Duration `json:"timeout"`
	NoPreflight      bool     `json:"noPreflight,omitempty"`
	SkipLLMPreflight bool     `json:"skipLLMPreflight,omitempty"`
}

// Validate applies the required-field checks. Handle normalisation must
// happen before Validate so the invariant "every path contains the
// handle" holds.
func (in JobInput) Validate() error {
	if in.V != JobInputVersion {
		return fmt.Errorf("flow.JobInput: v=%d, want %d", in.V, JobInputVersion)
	}
	if in.Handle == "" {
		return errors.New("flow.JobInput: handle is required")
	}
	if in.Max < 1 {
		return errors.New("flow.JobInput: max must be >= 1")
	}
	if in.DLWorkers < 1 {
		return errors.New("flow.JobInput: dlWorkers must be >= 1")
	}
	if in.AnalyzeWorkers < 1 {
		return errors.New("flow.JobInput: analyzeWorkers must be >= 1")
	}
	if in.ScrollRounds < 0 {
		return errors.New("flow.JobInput: scrollRounds must be >= 0")
	}
	if in.Timeout.D() <= 0 {
		return errors.New("flow.JobInput: timeout must be positive")
	}
	return nil
}

// NormalizeHandle strips '@', pulls the username out of an instagram.com
// URL, and rejects the bare host. Mirrors the rhai helpers strip_at and
// username_from_url so all callers agree on what "handle" means.
func NormalizeHandle(input string) (string, error) {
	s := strings.TrimSpace(input)
	if s == "" {
		return "", errors.New("flow.NormalizeHandle: empty input")
	}
	s = strings.TrimPrefix(s, "@")
	if strings.Contains(s, "instagram.com") {
		raw := s
		if !strings.Contains(raw, "://") {
			raw = "https://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil {
			return "", fmt.Errorf("flow.NormalizeHandle: parse %q: %w", input, err)
		}
		if u.Host == "" {
			return "", fmt.Errorf("flow.NormalizeHandle: no host in %q", input)
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		s = ""
		for _, p := range parts {
			if p != "" {
				s = p
				break
			}
		}
	}
	s = strings.TrimPrefix(s, "@")
	if s == "" || strings.EqualFold(s, "instagram.com") || strings.EqualFold(s, "www.instagram.com") {
		return "", fmt.Errorf("flow.NormalizeHandle: %q resolves to no username", input)
	}
	for _, r := range s {
		switch {
		case r == '.' || r == '_':
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		default:
			return "", fmt.Errorf("flow.NormalizeHandle: %q contains invalid rune %q", input, r)
		}
	}
	return s, nil
}

// BuildWorkflowID renders ig:<handle>:<unix-seconds>. The clock is read
// by the caller (workflow-determinism.md: workflows must not read the
// wall clock).
func BuildWorkflowID(handle string, now time.Time) string {
	return fmt.Sprintf("ig:%s:%d", handle, now.Unix())
}

// HandleFromWorkflowID is the inverse of BuildWorkflowID for well-formed
// ids; returns "" when the id does not match the ig:<handle>:<n> shape.
func HandleFromWorkflowID(id string) string {
	parts := strings.Split(id, ":")
	if len(parts) < 3 || parts[0] != "ig" {
		return ""
	}
	return parts[1]
}

// Derived output paths. Each path contains the handle (invariant 5).

// ProfileJSONPath is <root>/data/profiles/<handle>-profile.json.
func ProfileJSONPath(root, handle string) string {
	return filepath.Join(root, "data", "profiles", handle+"-profile.json")
}

// MediaDir is <root>/data/media/<handle>.
func MediaDir(root, handle string) string {
	return filepath.Join(root, "data", "media", handle)
}

// UniqueDir is <root>/data/<handle>-unique.
func UniqueDir(root, handle string) string {
	return filepath.Join(root, "data", handle+"-unique")
}

// AnalysisDir is <root>/data/analysis/<handle>.
func AnalysisDir(root, handle string) string {
	return filepath.Join(root, "data", "analysis", handle)
}

// KnowledgeDir is <root>/knowledge/clients/<handle>.
func KnowledgeDir(root, handle string) string {
	return filepath.Join(root, "knowledge", "clients", handle)
}

// Stage results. Small serialisable structs (paths, counts) so DBOS can
// checkpoint them without loading media contents into memory.

type ScrapeStageResult struct {
	OK        bool   `json:"ok"`
	Path      string `json:"path"`
	Posts     int    `json:"posts"`
	Reels     int    `json:"reels"`
	MediaURLs int    `json:"mediaUrls"`
	SHA256    string `json:"sha256,omitempty"`
}

type VerifyStageResult struct {
	OK         bool   `json:"ok"`
	Real       bool   `json:"real"`
	Evidence   string `json:"evidence"`
	Items      int    `json:"items"`
	EmptyMedia int    `json:"emptyMedia"`
	Reels      int    `json:"reels"`
}

type DownloadStageResult struct {
	OK         bool   `json:"ok"`
	Dir        string `json:"dir"`
	Attempted  int    `json:"attempted"`
	Downloaded int    `json:"downloaded"`
	Skipped    int    `json:"skipped"`
	Failed     int    `json:"failed"`
}

type UniqueStageResult struct {
	OK     bool   `json:"ok"`
	Dir    string `json:"dir"`
	Videos int    `json:"videos"`
	Stills int    `json:"stills"`
	Images int    `json:"images"`
	Unique int    `json:"unique"`
}

type AnalyzeStageResult struct {
	OK           bool   `json:"ok"`
	Dir          string `json:"dir"`
	AnalysisPath string `json:"analysisPath,omitempty"`
	DigestPath   string `json:"digestPath,omitempty"`
	Analyzed     int    `json:"analyzed"`
	Failed       int    `json:"failed"`
	Skipped      int    `json:"skipped"`
}

// KnowledgeStageInput is the checkpointed context needed to publish the wiki.
type KnowledgeStageInput struct {
	Job     JobInput           `json:"job"`
	Scrape  ScrapeStageResult  `json:"scrape"`
	Unique  UniqueStageResult  `json:"unique"`
	Analyze AnalyzeStageResult `json:"analyze"`
}

type KnowledgeStageResult struct {
	OK        bool     `json:"ok"`
	Handle    string   `json:"handle"`
	Dir       string   `json:"dir"`
	IndexPath string   `json:"indexPath"`
	Docs      []string `json:"docs"`
	Assets    int      `json:"assets"`
	InputHash string   `json:"inputHash"`
	Changed   bool     `json:"changed"`
}

// ScrapeResult is the durable return value of ScrapeJob.
type ScrapeResult struct {
	OK                 bool         `json:"ok"`
	Handle             string       `json:"handle"`
	ProfileJSON        string       `json:"profileJson"`
	MediaDir           string       `json:"mediaDir"`
	UniqueDir          string       `json:"uniqueDir"`
	AnalysisDir        string       `json:"analysisDir"`
	KnowledgeDir       string       `json:"knowledgeDir"`
	KnowledgeIndex     string       `json:"knowledgeIndex"`
	KnowledgeDocs      []string     `json:"knowledgeDocs,omitempty"`
	KnowledgeInputHash string       `json:"knowledgeInputHash,omitempty"`
	KnowledgeChanged   bool         `json:"knowledgeChanged,omitempty"`
	Counts             ScrapeCounts `json:"counts"`
	Skipped            []string     `json:"skipped,omitempty"`
}

// ScrapeCounts mirrors the epic CLI contract for `igflow run` output.
type ScrapeCounts struct {
	Posts           int `json:"posts"`
	Reels           int `json:"reels"`
	MediaURLs       int `json:"mediaUrls"`
	Downloaded      int `json:"downloaded"`
	Unique          int `json:"unique"`
	UniqueVideos    int `json:"uniqueVideos"`
	UniqueStills    int `json:"uniqueStills"`
	Analyzed        int `json:"analyzed"`
	KnowledgeDocs   int `json:"knowledgeDocs"`
	KnowledgeAssets int `json:"knowledgeAssets"`
}

// ProgressEvent is the payload of the "progress" event: {stage, done,
// total}. Total is the count of enabled stages including preflight.
type ProgressEvent struct {
	Stage string `json:"stage"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

// Stages is the pluggable seam for stage execution. Fake stages in
// tests record calls; the DefaultStages wrapper drives the real CLIs
// via exec.RunCLI.
//
// Every stage returns a small struct. The Scrape result is threaded
// into later stages that need path/counts context.
type Stages struct {
	Preflight func(ctx dbos.Context, in JobInput) (PreflightResult, error)
	Scrape    func(ctx dbos.Context, in JobInput) (ScrapeStageResult, error)
	Verify    func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (VerifyStageResult, error)
	Download  func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (DownloadStageResult, error)
	Unique    func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (UniqueStageResult, error)
	Analyze   func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (AnalyzeStageResult, error)
	Knowledge func(ctx dbos.Context, in KnowledgeStageInput) (KnowledgeStageResult, error)
}

var (
	stagesMu      sync.RWMutex
	currentStages = DefaultStages()
)

// SetStages installs the stage seam. Must be called before Launch so
// registered workflows see the intended stage functions on the very
// first dispatch.
func SetStages(s Stages) {
	stagesMu.Lock()
	defer stagesMu.Unlock()
	currentStages = s
}

// GetStages returns a snapshot of the installed stage seam. The workflow
// reads this at the top of each invocation so tests can rewire between
// runs.
func GetStages() Stages {
	stagesMu.RLock()
	defer stagesMu.RUnlock()
	return currentStages
}

// DefaultStages returns production stage wrappers that drive the real
// CLIs via exec.RunCLI. Each stage is a single-step wrapper using the
// per-stage retry policy from exec.go. Later beads (pt-igb.8/.9/.10)
// swap these out with richer implementations without touching the
// workflow function.
func DefaultStages() Stages {
	return Stages{
		Preflight: defaultPreflightStage,
		Scrape:    defaultScrapeStage,
		Verify:    defaultVerifyStage,
		Download:  defaultDownloadStage,
		Unique:    defaultUniqueStage,
		Analyze:   defaultAnalyzeStage,
	}
}

// jobRegistered guards RegisterAll so accidental double-registration in a
// single dbos.Context does not panic. Callers still must invoke
// RegisterAll once per NewHostContext (Shutdown clears the registry per
// test-setup.md).
var jobRegistered sync.Map // dbos.Context -> struct{}

// RegisterAll registers the ScrapeJob workflow and every queue in the
// tree. Must be called after NewHostContext and before dbos.Launch
// (workflow-constraints.md). Safe to call multiple times per context.
func RegisterAll(ctx dbos.Context) error {
	if _, seen := jobRegistered.LoadOrStore(ctx, struct{}{}); seen {
		return nil
	}
	dbos.RegisterWorkflow(ctx, ScrapeJob, dbos.WithWorkflowName("ScrapeJob"))
	dbos.RegisterWorkflow(ctx, ScrapeStage, dbos.WithWorkflowName("ScrapeStage"))
	dbos.RegisterWorkflow(ctx, DownloadMedia, dbos.WithWorkflowName("DownloadMedia"))
	dbos.RegisterWorkflow(ctx, UniqueMedia, dbos.WithWorkflowName("UniqueMedia"))
	dbos.RegisterWorkflow(ctx, AnalyzeMedia, dbos.WithWorkflowName("AnalyzeMedia"))

	if _, err := dbos.RegisterQueue(ctx, QueueIGJobs); err != nil {
		return fmt.Errorf("flow.RegisterAll: %s: %w", QueueIGJobs, err)
	}
	if _, err := dbos.RegisterQueue(ctx, QueueIGScrape, dbos.WithGlobalConcurrency(1)); err != nil {
		return fmt.Errorf("flow.RegisterAll: %s: %w", QueueIGScrape, err)
	}
	if _, err := dbos.RegisterQueue(ctx, QueueIGDownload, dbos.WithWorkerConcurrency(8)); err != nil {
		return fmt.Errorf("flow.RegisterAll: %s: %w", QueueIGDownload, err)
	}
	if _, err := dbos.RegisterQueue(ctx, QueueIGAnalyze, dbos.WithWorkerConcurrency(4)); err != nil {
		return fmt.Errorf("flow.RegisterAll: %s: %w", QueueIGAnalyze, err)
	}
	return nil
}

// EnqueueScrapeJob starts (or attaches to) a ScrapeJob on ig-jobs.
//   - WithWorkflowID(id) fixes the idempotency key (ig:<handle>:<n>).
//   - WithQueue(ig-jobs) parks the workflow on the parent queue.
//   - WithDeduplicationID(handle) collapses concurrent runs for one handle.
//   - WithDeduplicationPolicy(ReturnExisting) lets a second `igflow run`
//     attach to the earlier workflow instead of erroring.
func EnqueueScrapeJob(ctx dbos.Context, in JobInput, workflowID string) (dbos.WorkflowHandle[ScrapeResult], error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	if workflowID == "" {
		return nil, errors.New("flow.EnqueueScrapeJob: workflowID is required")
	}
	q, err := dbos.RetrieveQueue(ctx, QueueIGJobs)
	if err != nil {
		return nil, fmt.Errorf("flow.EnqueueScrapeJob: retrieve %s: %w", QueueIGJobs, err)
	}
	return dbos.RunWorkflow(ctx, ScrapeJob, in,
		dbos.WithWorkflowID(workflowID),
		dbos.WithQueue(q),
		dbos.WithDeduplicationID(in.Handle),
		dbos.WithDeduplicationPolicy(dbos.DeduplicationPolicyReturnExisting),
	)
}

// ScrapeJob is the parent durable workflow. It stays thin: pluggable
// stages own the I/O and DBOS checkpoints their results.
//
// Determinism: the workflow reads no wall clock, no env, no files.
// Stage skip flags come from JobInput. Events are set on every stage
// transition (comm-events.md); a "log" stream carries one line per
// transition (comm-streaming.md).
func ScrapeJob(ctx dbos.Context, in JobInput) (ScrapeResult, error) {
	st := GetStages()

	root, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
		return HomeDir()
	}, dbos.WithStepName("resolveRepoRoot"))
	if err != nil {
		_ = dbos.SetEvent(ctx, EventError, "resolveRepoRoot: "+err.Error())
		return ScrapeResult{}, err
	}

	result := ScrapeResult{
		Handle:      in.Handle,
		ProfileJSON: ProfileJSONPath(root, in.Handle),
		MediaDir:    MediaDir(root, in.Handle),
		UniqueDir:   UniqueDir(root, in.Handle),
		AnalysisDir: AnalysisDir(root, in.Handle),
	}

	total := 6
	// Retained in results so historical dashboards can mark the retired stage skipped.
	result.Skipped = append(result.Skipped, StageKnowledge)
	if in.NoPreflight {
		total--
	}
	if in.SkipDownload {
		total--
		result.Skipped = append(result.Skipped, StageDownload)
	}
	if in.SkipUnique {
		total--
		result.Skipped = append(result.Skipped, StageUnique)
	}
	if in.SkipAnalyze {
		total--
		result.Skipped = append(result.Skipped, StageAnalyze)
	}
	done := 0

	setStage := func(stage string) {
		_ = dbos.SetEvent(ctx, EventStage, stage)
		_ = dbos.SetEvent(ctx, EventProgress, ProgressEvent{Stage: stage, Done: done, Total: total})
		_ = dbos.WriteStream(ctx, StreamLog, fmt.Sprintf("stage=%s done=%d total=%d", stage, done, total))
	}
	failStage := func(stage string, err error) error {
		msg := err.Error()
		code := ""
		var cli *CLIError
		if errors.As(err, &cli) && cli.Code != "" {
			code = cli.Code
			msg = cli.Msg
		} else {
			// Child-workflow GetResult may flatten *CLIError to a string
			// (DBOS cannot gob-encode the concrete type).
			low := strings.ToLower(msg)
			switch {
			case strings.Contains(low, "code=llm"), strings.Contains(low, `"error":"llm"`), strings.Contains(low, "error: llm"):
				code = "llm"
			case strings.Contains(low, "code=auth"), strings.Contains(low, `"error":"auth"`), strings.Contains(low, "error: auth"):
				code = "auth"
			}
		}
		if code != "" {
			msg = fmt.Sprintf("%s: %s: %s", code, stage, msg)
		} else {
			msg = fmt.Sprintf("%s: %s", stage, msg)
		}
		_ = dbos.SetEvent(ctx, EventError, msg)
		_ = dbos.WriteStream(ctx, StreamLog, "error "+msg)
		_ = dbos.CloseStream(ctx, StreamLog)
		return err
	}

	// preflight (no retries; failure exits 5 in the CLI).
	if !in.NoPreflight && st.Preflight != nil {
		setStage(StagePreflight)
		if _, err := st.Preflight(ctx, in); err != nil {
			return result, failStage(StagePreflight, err)
		}
		done++
	}

	// scrape (ig-scrape, global concurrency 1).
	setStage(StageScrape)
	scrape, err := st.Scrape(ctx, in)
	if err != nil {
		return result, failStage(StageScrape, err)
	}
	if scrape.Path != "" {
		result.ProfileJSON = scrape.Path
	}
	result.Counts.Posts = scrape.Posts
	result.Counts.Reels = scrape.Reels
	result.Counts.MediaURLs = scrape.MediaURLs
	done++
	if err := crashAfter(ctx, StageScrape); err != nil {
		return result, failStage(StageScrape, err)
	}

	// verify (read-only; fail-closed).
	setStage(StageVerify)
	if _, err := st.Verify(ctx, in, scrape); err != nil {
		return result, failStage(StageVerify, err)
	}
	done++
	if err := crashAfter(ctx, StageVerify); err != nil {
		return result, failStage(StageVerify, err)
	}

	// download.
	if !in.SkipDownload {
		setStage(StageDownload)
		dl, err := st.Download(ctx, in, scrape)
		if err != nil {
			return result, failStage(StageDownload, err)
		}
		if dl.Dir != "" {
			result.MediaDir = dl.Dir
		}
		result.Counts.Downloaded = dl.Downloaded
		done++
		if err := crashAfter(ctx, StageDownload); err != nil {
			return result, failStage(StageDownload, err)
		}
	}

	// unique.
	var unique UniqueStageResult
	if !in.SkipUnique {
		setStage(StageUnique)
		unique, err = st.Unique(ctx, in, scrape)
		if err != nil {
			return result, failStage(StageUnique, err)
		}
		if unique.Dir != "" {
			result.UniqueDir = unique.Dir
		}
		result.Counts.Unique = unique.Unique
		result.Counts.UniqueVideos = unique.Videos
		result.Counts.UniqueStills = unique.Stills
		done++
		if err := crashAfter(ctx, StageUnique); err != nil {
			return result, failStage(StageUnique, err)
		}
	}

	// analyze.
	var analyze AnalyzeStageResult
	if !in.SkipAnalyze {
		setStage(StageAnalyze)
		analyze, err = st.Analyze(ctx, in, scrape)
		if err != nil {
			return result, failStage(StageAnalyze, err)
		}
		if analyze.Dir != "" {
			result.AnalysisDir = analyze.Dir
		}
		result.Counts.Analyzed = analyze.Analyzed
		done++
		if err := crashAfter(ctx, StageAnalyze); err != nil {
			return result, failStage(StageAnalyze, err)
		}
	}

	setStage(StageDone)
	_ = dbos.CloseStream(ctx, StreamLog)
	result.OK = true
	return result, nil
}
