package flow

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	_ "github.com/dbos-inc/dbos-transact-golang/dbos/driver/sqlite"
)

// bootTestHost brings up an in-memory-ish DBOS host on a temp SQLite
// file (test-setup.md). The test's own repo-root override keeps derived
// paths under t.TempDir() so no test writes to the shared data/ tree.
func bootTestHost(t *testing.T) dbos.Context {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("IGFLOW_REPO_ROOT", dir)
	t.Setenv("DBOS_SYSTEM_DATABASE_URL", "sqlite:"+filepath.Join(dir, "sys.sqlite"))

	ctx, err := dbos.NewContext(context.Background(), dbos.Config{
		AppName:            AppName,
		ApplicationVersion: ApplicationVersion,
		DatabaseURL:        "sqlite:" + filepath.Join(dir, "sys.sqlite"),
		AdminServer:        false,
	})
	if err != nil {
		t.Fatalf("dbos.NewContext: %v", err)
	}
	t.Cleanup(func() { _ = dbos.Shutdown(ctx, 10*time.Second) })
	if err := RegisterAll(ctx); err != nil {
		t.Fatalf("RegisterAll: %v", err)
	}
	if err := dbos.Launch(ctx); err != nil {
		t.Fatalf("dbos.Launch: %v", err)
	}
	return ctx
}

// fakeStages captures every stage call and lets tests drive per-stage
// success/error/wait behaviour.
type fakeStages struct {
	mu       sync.Mutex
	calls    map[string]int
	scrapeRV ScrapeStageResult

	// Optional blockers/errors, keyed by stage name.
	block map[string]chan struct{}
	fail  map[string]error
}

func newFakeStages() *fakeStages {
	return &fakeStages{
		calls:    map[string]int{},
		scrapeRV: ScrapeStageResult{OK: true, Path: "fake/profile.json", Posts: 3, Reels: 1, MediaURLs: 9},
		block:    map[string]chan struct{}{},
		fail:     map[string]error{},
	}
}

func (f *fakeStages) count(stage string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[stage]
}

func (f *fakeStages) record(stage string) {
	f.mu.Lock()
	f.calls[stage]++
	blk := f.block[stage]
	fail := f.fail[stage]
	f.mu.Unlock()
	if blk != nil {
		<-blk
	}
	_ = fail
}

func (f *fakeStages) install() {
	SetStages(Stages{
		Preflight: func(ctx dbos.Context, in JobInput) (PreflightResult, error) {
			f.record(StagePreflight)
			return PreflightResult{OK: true}, f.fail[StagePreflight]
		},
		Scrape: func(ctx dbos.Context, in JobInput) (ScrapeStageResult, error) {
			f.record(StageScrape)
			if err := f.fail[StageScrape]; err != nil {
				return ScrapeStageResult{}, err
			}
			return f.scrapeRV, nil
		},
		Verify: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (VerifyStageResult, error) {
			f.record(StageVerify)
			if err := f.fail[StageVerify]; err != nil {
				return VerifyStageResult{}, err
			}
			return VerifyStageResult{OK: true, Real: true}, nil
		},
		Download: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (DownloadStageResult, error) {
			f.record(StageDownload)
			if err := f.fail[StageDownload]; err != nil {
				return DownloadStageResult{}, err
			}
			return DownloadStageResult{OK: true, Downloaded: 9}, nil
		},
		Unique: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (UniqueStageResult, error) {
			f.record(StageUnique)
			if err := f.fail[StageUnique]; err != nil {
				return UniqueStageResult{}, err
			}
			return UniqueStageResult{OK: true, Videos: 2, Stills: 3, Images: 2, Unique: 7}, nil
		},
		Analyze: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (AnalyzeStageResult, error) {
			f.record(StageAnalyze)
			if err := f.fail[StageAnalyze]; err != nil {
				return AnalyzeStageResult{}, err
			}
			return AnalyzeStageResult{OK: true, Analyzed: 5}, nil
		},
		Knowledge: func(ctx dbos.Context, in KnowledgeStageInput) (KnowledgeStageResult, error) {
			f.record(StageKnowledge)
			if err := f.fail[StageKnowledge]; err != nil {
				return KnowledgeStageResult{}, err
			}
			dir := "knowledge/clients/" + in.Job.Handle
			return KnowledgeStageResult{
				OK: true, Handle: in.Job.Handle, Dir: dir, IndexPath: dir + "/INDEX.md",
				Docs:   []string{dir + "/PROFILE.md", dir + "/STYLE.md", dir + "/POSTS.md", dir + "/IDEAS.md", dir + "/INDEX.md"},
				Assets: 7, InputHash: strings.Repeat("a", 64), Changed: true,
			}, nil
		},
	})
}

// defaultInput yields a normalised handle and every field set.
func defaultInput(handle string) JobInput {
	return JobInput{
		V:              JobInputVersion,
		Handle:         handle,
		Max:            10,
		Detail:         true,
		DLWorkers:      2,
		AnalyzeWorkers: 2,
		PerShortcode:   true,
		Timeout:        Duration(30 * time.Second),
		NoPreflight:    true, // most tests skip preflight to keep counts tidy
	}
}

func TestScrapeJob_HappyPath(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("fixturetest")
	wfID := BuildWorkflowID(in.Handle, time.Now())
	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	result, err := handle.GetResult()
	if err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false: %+v", result)
	}
	// The scrape stage may override ProfileJSON with the actual path it wrote.
	// The other three derived paths (media/unique/analysis) must still contain
	// the handle (invariant 5).
	for _, path := range []string{result.MediaDir, result.UniqueDir, result.AnalysisDir} {
		if !strings.Contains(path, "fixturetest") {
			t.Fatalf("path %q missing handle fixturetest", path)
		}
	}
	if result.ProfileJSON != "fake/profile.json" {
		t.Fatalf("scrape path override lost: %q", result.ProfileJSON)
	}
	if result.Counts.Posts != 3 || result.Counts.MediaURLs != 9 || result.Counts.Downloaded != 9 || result.Counts.Unique != 7 || result.Counts.UniqueVideos != 2 || result.Counts.UniqueStills != 3 || result.Counts.Analyzed != 5 || result.Counts.KnowledgeDocs != 0 || result.Counts.KnowledgeAssets != 0 {
		t.Fatalf("counts wrong: %+v", result.Counts)
	}
	if result.KnowledgeIndex != "" || len(result.KnowledgeDocs) != 0 || result.KnowledgeInputHash != "" || result.KnowledgeDir != "" {
		t.Fatalf("knowledge result wrong: %+v", result)
	}
	for _, stage := range []string{StageScrape, StageVerify, StageDownload, StageUnique, StageAnalyze} {
		if fake.count(stage) == 0 {
			t.Fatalf("stage %s never called", stage)
		}
	}
	if fake.count(StagePreflight) != 0 {
		t.Fatalf("preflight ran despite NoPreflight=true")
	}
	// Final event should be "done".
	stage, err := dbos.GetEvent[string](ctx, wfID, EventStage, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("GetEvent stage: %v", err)
	}
	if stage != StageDone {
		t.Fatalf("stage event = %q, want %q", stage, StageDone)
	}
}

func TestScrapeJob_PreflightRunsFirst(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("preflighttest")
	in.NoPreflight = false
	wfID := BuildWorkflowID(in.Handle, time.Now())
	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	if _, err := handle.GetResult(); err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	if fake.count(StagePreflight) != 1 {
		t.Fatalf("preflight count = %d, want 1", fake.count(StagePreflight))
	}
}

func TestScrapeJob_ScrapeErrorSkipsDownstream(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	fake.fail[StageScrape] = &CLIError{Stage: StageScrape, ExitCode: 1, Retryable: false, Msg: "scrape blew up"}
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("errtest")
	wfID := BuildWorkflowID(in.Handle, time.Now())
	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	if _, err := handle.GetResult(); err == nil {
		t.Fatalf("GetResult: expected error, got nil")
	}
	status, err := handle.GetStatus()
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if status.Status != dbos.WorkflowStatusError {
		t.Fatalf("status = %s, want ERROR", status.Status)
	}
	// Downstream stages never ran.
	for _, stage := range []string{StageVerify, StageDownload, StageUnique, StageAnalyze, StageKnowledge} {
		if fake.count(stage) != 0 {
			t.Fatalf("stage %s ran despite scrape error", stage)
		}
	}
	msg, err := dbos.GetEvent[string](ctx, wfID, EventError, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("GetEvent error: %v", err)
	}
	if !strings.Contains(msg, "scrape") {
		t.Fatalf("error event %q missing stage tag", msg)
	}
}

func TestScrapeJob_AuthErrorTagsMessage(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	fake.fail[StageScrape] = &CLIError{Stage: StageScrape, ExitCode: ExitAuthFail, Retryable: false, Code: "auth", Msg: "login wall"}
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("authtest")
	wfID := BuildWorkflowID(in.Handle, time.Now())
	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	if _, err := handle.GetResult(); err == nil {
		t.Fatalf("expected auth error")
	}
	msg, err := dbos.GetEvent[string](ctx, wfID, EventError, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("GetEvent error: %v", err)
	}
	if !strings.HasPrefix(msg, "auth:") {
		t.Fatalf("event %q missing auth: prefix", msg)
	}
}

func TestScrapeJob_SkipsHonoured(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("skiptest")
	in.SkipDownload = true
	in.SkipAnalyze = true
	in.SkipKB = true
	wfID := BuildWorkflowID(in.Handle, time.Now())
	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	if _, err := handle.GetResult(); err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	if fake.count(StageDownload) != 0 {
		t.Fatalf("download ran despite SkipDownload")
	}
	if fake.count(StageAnalyze) != 0 {
		t.Fatalf("analyze ran despite SkipAnalyze")
	}
	if fake.count(StageUnique) != 1 {
		t.Fatalf("unique count = %d, want 1", fake.count(StageUnique))
	}
	if fake.count(StageKnowledge) != 0 {
		t.Fatalf("knowledge ran despite SkipKB")
	}
}

func TestScrapeJob_LegacyKnowledgeSettingsNeverPublish(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	fake.fail[StageKnowledge] = &CLIError{Stage: StageKnowledge, ExitCode: 1, Retryable: false, Msg: "OpenKnowledge write failed"}
	fake.install()
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("kbfail")
	wfID := BuildWorkflowID(in.Handle, time.Now())
	handle, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatalf("EnqueueScrapeJob: %v", err)
	}
	if _, err := handle.GetResult(); err != nil {
		t.Fatalf("collection must complete without wiki publishing: %v", err)
	}
	if fake.count(StageKnowledge) != 0 {
		t.Fatalf("collection invoked the retired wiki stage")
	}
}

func TestScrapeJob_DedupReturnsExisting(t *testing.T) {
	ctx := bootTestHost(t)
	fake := newFakeStages()
	// Block scrape so the first workflow stays PENDING while the second call
	// races through the deduplication gate.
	release := make(chan struct{})
	scrapeStarted := make(chan struct{})
	var startedOnce int32
	fake.install() // seed a baseline, then override Scrape with the blocker.
	SetStages(Stages{
		Preflight: nil,
		Scrape: func(ctx dbos.Context, in JobInput) (ScrapeStageResult, error) {
			if atomic.AddInt32(&startedOnce, 1) == 1 {
				close(scrapeStarted)
			}
			<-release
			return ScrapeStageResult{OK: true, Path: "fake/profile.json"}, nil
		},
		Verify: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (VerifyStageResult, error) {
			return VerifyStageResult{OK: true}, nil
		},
		Download: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (DownloadStageResult, error) {
			return DownloadStageResult{OK: true}, nil
		},
		Unique: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (UniqueStageResult, error) {
			return UniqueStageResult{OK: true}, nil
		},
		Analyze: func(ctx dbos.Context, in JobInput, s ScrapeStageResult) (AnalyzeStageResult, error) {
			return AnalyzeStageResult{OK: true}, nil
		},
		Knowledge: func(ctx dbos.Context, in KnowledgeStageInput) (KnowledgeStageResult, error) {
			return KnowledgeStageResult{OK: true, Handle: in.Job.Handle}, nil
		},
	})
	t.Cleanup(func() { SetStages(DefaultStages()) })

	in := defaultInput("duptest")
	firstID := BuildWorkflowID(in.Handle, time.Now())
	h1, err := EnqueueScrapeJob(ctx, in, firstID)
	if err != nil {
		t.Fatalf("first EnqueueScrapeJob: %v", err)
	}
	select {
	case <-scrapeStarted:
	case <-time.After(2 * time.Second):
		t.Fatalf("scrape stage never started")
	}
	secondID := BuildWorkflowID(in.Handle, time.Now().Add(time.Second))
	h2, err := EnqueueScrapeJob(ctx, in, secondID)
	if err != nil {
		t.Fatalf("second EnqueueScrapeJob: %v", err)
	}
	if h2.GetWorkflowID() != h1.GetWorkflowID() {
		t.Fatalf("dedup did not attach: first=%s second=%s", h1.GetWorkflowID(), h2.GetWorkflowID())
	}
	close(release)
	if _, err := h1.GetResult(); err != nil {
		t.Fatalf("first result: %v", err)
	}
	if _, err := h2.GetResult(); err != nil {
		t.Fatalf("second result: %v", err)
	}
}

func TestScrapeJob_QueuesRegistered(t *testing.T) {
	ctx := bootTestHost(t)
	queues, err := dbos.ListQueues(ctx)
	if err != nil {
		t.Fatalf("ListQueues: %v", err)
	}
	got := map[string]bool{}
	for _, q := range queues {
		got[q.GetName()] = true
	}
	for _, want := range []string{QueueIGJobs, QueueIGScrape, QueueIGDownload, QueueIGAnalyze} {
		if !got[want] {
			t.Fatalf("queue %s not registered; got %v", want, got)
		}
	}
}

func TestNormalizeHandle_Table(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"foo", "foo", false},
		{"@foo", "foo", false},
		{"https://www.instagram.com/foo/", "foo", false},
		{"https://instagram.com/foo/", "foo", false},
		{"instagram.com/foo", "foo", false},
		{"@bar.baz_1", "bar.baz_1", false},
		{"instagram.com", "", true},
		{"https://www.instagram.com/", "", true},
		{"", "", true},
		{"bad name", "", true},
		{"foo/bar", "", true},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got, err := NormalizeHandle(c.in)
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestDerivedPaths_ContainHandle(t *testing.T) {
	handle := "unit_test.user"
	root := t.TempDir()
	for _, p := range []string{
		ProfileJSONPath(root, handle),
		MediaDir(root, handle),
		UniqueDir(root, handle),
		AnalysisDir(root, handle),
	} {
		if !strings.Contains(p, handle) {
			t.Fatalf("path %q missing handle %q", p, handle)
		}
	}
}

func TestBuildWorkflowID_RoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	id := BuildWorkflowID("acct", now)
	want := fmt.Sprintf("ig:acct:%d", now.Unix())
	if id != want {
		t.Fatalf("id = %q, want %q", id, want)
	}
	if h := HandleFromWorkflowID(id); h != "acct" {
		t.Fatalf("handle from id = %q, want %q", h, "acct")
	}
}

func TestDuration_JSONRoundTrip(t *testing.T) {
	d := Duration(6 * time.Hour)
	b, err := d.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	if string(b) != `"6h0m0s"` {
		t.Fatalf("marshal = %s, want \"6h0m0s\"", string(b))
	}
	var out Duration
	if err := out.UnmarshalJSON([]byte(`"6h"`)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	if out.D() != 6*time.Hour {
		t.Fatalf("unmarshal = %v, want 6h", out.D())
	}
	if err := out.UnmarshalJSON([]byte(`21600000000000`)); err != nil {
		t.Fatalf("UnmarshalJSON int: %v", err)
	}
	if out.D() != 6*time.Hour {
		t.Fatalf("unmarshal int = %v, want 6h", out.D())
	}
}

func TestJobInput_ValidateRejectsBadFields(t *testing.T) {
	base := defaultInput("ok")
	base.V = 0
	if err := base.Validate(); err == nil {
		t.Fatalf("expected version error")
	}
	base.V = JobInputVersion
	base.Timeout = 0
	if err := base.Validate(); err == nil {
		t.Fatalf("expected timeout error")
	}
}

// Guard against workflow re-registration panics when the same test
// binary spins up multiple contexts back-to-back.
func TestRegisterAll_Idempotent(t *testing.T) {
	ctx := bootTestHost(t)
	if err := RegisterAll(ctx); err != nil {
		t.Fatalf("second RegisterAll: %v", err)
	}
	// Same context: no error.
	if err := RegisterAll(ctx); err != nil {
		t.Fatalf("third RegisterAll: %v", err)
	}
	// Fresh context: fine.
	dir := t.TempDir()
	other, err := dbos.NewContext(context.Background(), dbos.Config{
		AppName:            AppName + "-alt",
		ApplicationVersion: ApplicationVersion,
		DatabaseURL:        "sqlite:" + filepath.Join(dir, "sys.sqlite"),
		AdminServer:        false,
	})
	if err != nil {
		t.Fatalf("second NewContext: %v", err)
	}
	t.Cleanup(func() { _ = dbos.Shutdown(other, 5*time.Second) })
	if err := RegisterAll(other); err != nil {
		t.Fatalf("RegisterAll on second ctx: %v", err)
	}
}

// Sanity: retry predicate on CLIError vs plain error.
func TestRetryPredicate_Interop(t *testing.T) {
	if RetryPredicate(nil) {
		t.Fatalf("nil should not be retryable")
	}
	if RetryPredicate(errors.New("boom")) != true {
		t.Fatalf("plain errors should be retryable by default")
	}
	if RetryPredicate(&CLIError{Retryable: false, Code: "auth"}) {
		t.Fatalf("auth CLIError must not retry")
	}
	if !RetryPredicate(&CLIError{Retryable: true}) {
		t.Fatalf("retryable CLIError should retry")
	}
}
