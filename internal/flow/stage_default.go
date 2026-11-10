package flow

import (
	"context"
	"os"
	"strconv"
	"strings"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

// defaultPreflightStage runs the composite preflight: env + LLM ping +
// cookie-jar + tool checks. Non-retryable (failed preflight is a human
// problem, not a flake). pt-igb.27.
func defaultPreflightStage(ctx dbos.Context, in JobInput) (PreflightResult, error) {
	wfID, _ := dbos.GetWorkflowID(ctx)
	return dbos.RunAsStep(ctx, func(sctx context.Context) (PreflightResult, error) {
		return RunPreflight(sctx, in, wfID, "")
	}, dbos.WithStepName(StagePreflight),
		dbos.WithStepMaxRetries(0),
		dbos.WithStepRetryPredicate(RetryPredicate))
}

// defaultScrapeStage starts the ScrapeStage child on ig-scrape
// (global concurrency 1) and waits for its result.
func defaultScrapeStage(ctx dbos.Context, in JobInput) (ScrapeStageResult, error) {
	q, err := dbos.RetrieveQueue(ctx, QueueIGScrape)
	if err != nil {
		return ScrapeStageResult{}, err
	}
	h, err := dbos.RunWorkflow(ctx, ScrapeStage, in, dbos.WithQueue(q))
	if err != nil {
		return ScrapeStageResult{}, err
	}
	return h.GetResult()
}

// defaultVerifyStage runs VerifyProfile as a no-retry step. IGFLOW_VERIFY_CMD
// remains a fixture seam for recovery tests that want to skip the file check.
func defaultVerifyStage(ctx dbos.Context, in JobInput, s ScrapeStageResult) (VerifyStageResult, error) {
	wfID, _ := dbos.GetWorkflowID(ctx)
	profileArg := s.Path
	if profileArg == "" {
		profileArg = ProfileJSONPath(homeOrRelative(), in.Handle)
	}
	return dbos.RunAsStep(ctx, func(sctx context.Context) (VerifyStageResult, error) {
		if strings.TrimSpace(os.Getenv(EnvVerifyCmd)) != "" {
			res, err := RunCLI(sctx, CLISpec{
				Name:        StageVerify,
				Argv:        []string{"true", "--profile", profileArg},
				EnvOverride: EnvVerifyCmd,
				WorkflowID:  wfID,
			})
			if err != nil {
				return VerifyStageResult{}, err
			}
			return VerifyStageResult{
				OK:       res.OK(),
				Real:     boolField(res.JSON, "real", true),
				Evidence: res.String("evidence"),
			}, nil
		}
		return VerifyProfile(sctx, VerifyInput{
			Path:      profileArg,
			Handle:    in.Handle,
			SkipReels: in.SkipReels,
			SHA256:    s.SHA256,
		})
	}, dbos.WithStepName(StageVerify), dbos.WithStepMaxRetries(0), dbos.WithStepRetryPredicate(RetryPredicate))
}

func defaultDownloadStage(ctx dbos.Context, in JobInput, s ScrapeStageResult) (DownloadStageResult, error) {
	// Run as parent steps (not a child GetResult) so `igflow resume` re-runs a
	// failed exec. DownloadMedia remains a registered workflow for M2.
	return DownloadMedia(ctx, ChildStageInput{Job: in, Scrape: s})
}

func defaultUniqueStage(ctx dbos.Context, in JobInput, s ScrapeStageResult) (UniqueStageResult, error) {
	return UniqueMedia(ctx, ChildStageInput{Job: in, Scrape: s})
}

func defaultAnalyzeStage(ctx dbos.Context, in JobInput, s ScrapeStageResult) (AnalyzeStageResult, error) {
	return AnalyzeMedia(ctx, ChildStageInput{Job: in, Scrape: s})
}

func stepOpts(stage string, p RetryPolicy) []dbos.StepOption {
	return []dbos.StepOption{
		dbos.WithStepName(stage),
		dbos.WithStepMaxRetries(p.MaxRetries),
		dbos.WithStepBaseInterval(p.BaseInterval),
		dbos.WithStepMaxInterval(p.MaxInterval),
		dbos.WithStepRetryPredicate(RetryPredicate),
	}
}

func scrapeArgv(in JobInput) []string {
	argv := []string{"bun", "run", "scrape-profile", "--"}
	if in.SkipLLMPreflight {
		argv = append(argv, "--skip-llm-preflight")
	}
	if in.ProfileURL != "" {
		argv = append(argv, "--url", in.ProfileURL)
	} else {
		argv = append(argv, "--url", "https://www.instagram.com/"+in.Handle+"/")
	}
	argv = append(argv, "--max", strconv.Itoa(in.Max))
	if in.Fresh {
		argv = append(argv, "--fresh")
	} else {
		argv = append(argv, "--resume")
	}
	if in.Detail {
		argv = append(argv, "--detail")
	} else {
		argv = append(argv, "--no-detail")
	}
	if in.SkipReels {
		argv = append(argv, "--skip-reels")
	}
	if in.ForceLogin {
		argv = append(argv, "--force-login")
	}
	if in.ScrollRounds > 0 {
		argv = append(argv, "--scroll-rounds", strconv.Itoa(in.ScrollRounds))
	}
	return argv
}

func igdlArgv(in JobInput, profile string) []string {
	argv := []string{"go", "run", "./cmd/igdl", "-in", profile, "-out", MediaDir(homeOrRelative(), in.Handle), "-workers", strconv.Itoa(in.DLWorkers)}
	if in.Fresh {
		argv = append(argv, "-fresh")
	}
	if in.SkipReels {
		argv = append(argv, "-skip-reels")
	}
	return argv
}

func iguniqueArgv(in JobInput, profile string) []string {
	argv := []string{"go", "run", "./cmd/igunique", "-in", profile, "-media", MediaDir(homeOrRelative(), in.Handle), "-out", UniqueDir(homeOrRelative(), in.Handle)}
	if in.Fresh {
		argv = append(argv, "-fresh")
	}
	if in.SkipReels {
		argv = append(argv, "-skip-reels")
	}
	return argv
}

func iganalyzeArgv(in JobInput, profile string) []string {
	argv := []string{"go", "run", "./cmd/iganalyze", "-profile", profile, "-media", MediaDir(homeOrRelative(), in.Handle), "-out", AnalysisDir(homeOrRelative(), in.Handle), "-workers", strconv.Itoa(in.AnalyzeWorkers)}
	if in.AllFrames {
		argv = append(argv, "-all-frames")
	} else if in.PerShortcode {
		argv = append(argv, "-per-shortcode")
	}
	if in.Fresh {
		argv = append(argv, "-fresh")
	}
	if in.SkipReels {
		argv = append(argv, "-skip-reels")
	}
	return argv
}

// nestedInt digs into res.JSON along the given key path and returns the
// integer value, or 0 when missing. Handles JSON's float64 decoding.
func nestedInt(m map[string]any, path ...string) int {
	if m == nil {
		return 0
	}
	cur := any(m)
	for _, k := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			return 0
		}
		cur = obj[k]
	}
	switch v := cur.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0
		}
		return n
	}
	return 0
}

func boolField(m map[string]any, key string, def bool) bool {
	if m == nil {
		return def
	}
	if v, ok := m[key].(bool); ok {
		return v
	}
	return def
}
