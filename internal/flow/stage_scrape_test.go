package flow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

func testdataCmd(t *testing.T, name string) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(wd, "testdata", name)
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
	return "bash " + p
}

func installFixtureStages(t *testing.T, calls string) {
	t.Helper()
	t.Setenv(EnvScrapeCmd, testdataCmd(t, "scrape-ok.sh"))
	t.Setenv(EnvIGDLCmd, testdataCmd(t, "igdl-ok.sh"))
	t.Setenv(EnvIGUniqueCmd, testdataCmd(t, "igunique-ok.sh"))
	t.Setenv(EnvIGAnalyzeCmd, testdataCmd(t, "iganalyze-ok.sh"))
	t.Setenv("IGFLOW_TEST_CALLS", calls)
	SetStages(DefaultStages())
	t.Cleanup(func() { SetStages(DefaultStages()) })
}

func TestScrapeStage_FixtureOK(t *testing.T) {
	ctx := bootTestHost(t)
	calls := filepath.Join(t.TempDir(), "calls")
	installFixtureStages(t, calls)

	in := defaultInput("okhandle")
	in.SkipDownload = true
	in.SkipUnique = true
	in.SkipAnalyze = true
	wfID := BuildWorkflowID(in.Handle, time.Now())
	h, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := h.GetResult()
	if err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	if !result.OK || result.Counts.Posts != 2 || result.Counts.MediaURLs != 3 {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.ProfileJSON, "okhandle") {
		t.Fatalf("path %q missing handle", result.ProfileJSON)
	}
	sum, err := hashFileSHA256(result.ProfileJSON)
	if err != nil {
		t.Fatal(err)
	}
	if sum == "" {
		t.Fatal("empty sha")
	}
	steps, err := dbos.GetWorkflowSteps(ctx, wfID, dbos.WithStepsLoadOutput(false))
	if err != nil {
		t.Fatal(err)
	}
	var child string
	for _, s := range steps {
		if s.ChildWorkflowID != "" {
			child = s.ChildWorkflowID
			break
		}
	}
	if child == "" {
		t.Fatalf("expected scrape childWorkflowId in steps: %+v", steps)
	}
}

func TestScrapeStage_LoginWallNoRetry(t *testing.T) {
	ctx := bootTestHost(t)
	calls := filepath.Join(t.TempDir(), "calls")
	installFixtureStages(t, calls)
	t.Setenv(EnvScrapeCmd, testdataCmd(t, "scrape-loginwall.sh"))
	SetStages(DefaultStages())

	in := defaultInput("walluser")
	in.SkipDownload = true
	in.SkipUnique = true
	in.SkipAnalyze = true
	wfID := BuildWorkflowID(in.Handle, time.Now())
	h, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.GetResult(); err == nil {
		t.Fatal("expected auth error")
	}
	body, _ := os.ReadFile(calls)
	n := strings.Count(string(body), "scrape")
	if n != 1 {
		t.Fatalf("loginwall retried: calls=%q count=%d", body, n)
	}
}

func TestScrapeStage_FlakyRetriesThenSucceeds(t *testing.T) {
	ctx := bootTestHost(t)
	calls := filepath.Join(t.TempDir(), "calls")
	installFixtureStages(t, calls)
	t.Setenv(EnvScrapeCmd, testdataCmd(t, "scrape-flaky.sh"))
	old := ScrapeRetryPolicy
	ScrapeRetryPolicy = RetryPolicy{MaxRetries: 2, BaseInterval: 20 * time.Millisecond, MaxInterval: 50 * time.Millisecond}
	t.Cleanup(func() { ScrapeRetryPolicy = old })
	SetStages(DefaultStages())

	in := defaultInput("flakyuser")
	in.SkipDownload = true
	in.SkipUnique = true
	in.SkipAnalyze = true
	wfID := BuildWorkflowID(in.Handle, time.Now())
	h, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.GetResult(); err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	body, _ := os.ReadFile(calls)
	n := strings.Count(string(body), "scrape")
	if n != 2 {
		t.Fatalf("flaky calls = %d want 2 (%q)", n, body)
	}
}

func TestScrapeStage_SerialisesOnQueue(t *testing.T) {
	ctx := bootTestHost(t)
	calls := filepath.Join(t.TempDir(), "calls")
	installFixtureStages(t, calls)
	t.Setenv(EnvScrapeCmd, testdataCmd(t, "scrape-block.sh"))
	t.Setenv("IGFLOW_TEST_SLEEP", "2")
	SetStages(DefaultStages())

	in1 := defaultInput("blockone")
	in1.SkipDownload, in1.SkipUnique, in1.SkipAnalyze = true, true, true
	in2 := defaultInput("blocktwo")
	in2.SkipDownload, in2.SkipUnique, in2.SkipAnalyze = true, true, true

	h1, err := EnqueueScrapeJob(ctx, in1, BuildWorkflowID(in1.Handle, time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	h2, err := EnqueueScrapeJob(ctx, in2, BuildWorkflowID(in2.Handle, time.Now().Add(time.Second)))
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	sawEnqueued := false
	for time.Now().Before(deadline) {
		wfs, err := dbos.ListWorkflows(ctx, dbos.WithFilterQueueName(QueueIGScrape))
		if err != nil {
			t.Fatal(err)
		}
		for _, wf := range wfs {
			if wf.Status == dbos.WorkflowStatusEnqueued {
				sawEnqueued = true
				break
			}
		}
		if sawEnqueued {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !sawEnqueued {
		t.Fatal("expected a second scrape child to sit ENQUEUED on ig-scrape")
	}
	if _, err := h1.GetResult(); err != nil {
		t.Fatalf("h1: %v", err)
	}
	if _, err := h2.GetResult(); err != nil {
		t.Fatalf("h2: %v", err)
	}
}

func TestMediaStages_Fixtures(t *testing.T) {
	ctx := bootTestHost(t)
	calls := filepath.Join(t.TempDir(), "calls")
	installFixtureStages(t, calls)

	in := defaultInput("mediauser")
	wfID := BuildWorkflowID(in.Handle, time.Now())
	h, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := h.GetResult()
	if err != nil {
		t.Fatalf("GetResult: %v", err)
	}
	if result.Counts.Downloaded != 3 || result.Counts.Unique < 1 || result.Counts.Analyzed != 2 {
		t.Fatalf("counts = %+v", result.Counts)
	}
	steps, err := dbos.GetWorkflowSteps(ctx, wfID, dbos.WithStepsLoadOutput(false))
	if err != nil {
		t.Fatal(err)
	}
	children := 0
	for _, s := range steps {
		if s.ChildWorkflowID != "" {
			children++
		}
	}
	if children < 1 {
		t.Fatalf("want scrape child workflow, got %d from %+v", children, steps)
	}
	body, _ := os.ReadFile(calls)
	if !strings.Contains(string(body), "igdl") || !strings.Contains(string(body), "igunique") || !strings.Contains(string(body), "iganalyze") {
		t.Fatalf("missing stage calls: %s", body)
	}
	if strings.Contains(string(body), "knowledge") {
		t.Fatal("collection must not publish a wiki")
	}
}

func TestAnalyzeStage_LLMNonRetryable(t *testing.T) {
	ctx := bootTestHost(t)
	calls := filepath.Join(t.TempDir(), "calls")
	installFixtureStages(t, calls)
	t.Setenv(EnvIGAnalyzeCmd, testdataCmd(t, "iganalyze-llm.sh"))
	SetStages(DefaultStages())

	in := defaultInput("llmuser")
	in.SkipDownload = true
	in.SkipUnique = true
	wfID := BuildWorkflowID(in.Handle, time.Now())
	h, err := EnqueueScrapeJob(ctx, in, wfID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.GetResult(); err == nil {
		t.Fatal("expected llm error")
	}
	msg, err := dbos.GetEvent[string](ctx, wfID, EventError, 200*time.Millisecond)
	if err != nil || !strings.HasPrefix(msg, "llm:") {
		t.Fatalf("error event = %q err=%v (want llm: prefix)", msg, err)
	}
}
