package flow

import (
	"context"
	"fmt"
	"strings"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

// ScrapeStage is the ig-scrape child workflow: one bun scrape-profile
// exec step (retried) plus a SHA-256 of the profile JSON. Global
// concurrency 1 serialises Chrome usage across jobs.
func ScrapeStage(ctx dbos.Context, in JobInput) (ScrapeStageResult, error) {
	wfID, _ := dbos.GetWorkflowID(ctx)
	root, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
		return HomeDir()
	}, dbos.WithStepName("scrape-root"))
	if err != nil {
		return ScrapeStageResult{}, err
	}

	argv := scrapeArgv(in)
	res, err := dbos.RunAsStep(ctx, func(sctx context.Context) (CLIResult, error) {
		return RunCLI(sctx, CLISpec{
			Name:        StageScrape,
			Argv:        argv,
			EnvOverride: EnvScrapeCmd,
			WorkflowID:  wfID,
			Env: []string{
				"IGFLOW_TEST_HANDLE=" + in.Handle,
				"IGFLOW_TEST_OUT=" + ProfileJSONPath(root, in.Handle),
			},
		})
	}, stepOpts("runScrape", ScrapeRetryPolicy)...)
	if err != nil {
		return ScrapeStageResult{}, err
	}

	path := res.String("path")
	if path == "" {
		path = ProfileJSONPath(root, in.Handle)
	}
	path = absFromRoot(root, path)
	if !strings.Contains(strings.ToLower(path), strings.ToLower(in.Handle)) {
		return ScrapeStageResult{}, &CLIError{
			Stage:     StageScrape,
			Retryable: false,
			Msg:       fmt.Sprintf("scrape path %q does not contain handle %q", path, in.Handle),
		}
	}

	sum, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
		return hashFileSHA256(path)
	}, dbos.WithStepName("scrape-sha256"), dbos.WithStepMaxRetries(0))
	if err != nil {
		return ScrapeStageResult{}, err
	}

	return ScrapeStageResult{
		OK:        res.OK(),
		Path:      path,
		Posts:     nestedInt(res.JSON, "counts", "posts"),
		Reels:     nestedInt(res.JSON, "counts", "reels"),
		MediaURLs: nestedInt(res.JSON, "counts", "mediaUrls"),
		SHA256:    sum,
	}, nil
}
