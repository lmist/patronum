package flow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

// ChildStageInput is the portable input for download/unique/analyze
// child workflows. Keep it small: the parent already checkpointed scrape.
type ChildStageInput struct {
	Job    JobInput          `json:"job"`
	Scrape ScrapeStageResult `json:"scrape"`
}

type igdlManifest struct {
	Username string `json:"username"`
	OutDir   string `json:"outDir"`
	Total    int    `json:"total"`
	OK       int    `json:"ok"`
	Skipped  int    `json:"skipped"`
	Failed   int    `json:"failed"`
}

type iguniqueManifest struct {
	Username    string          `json:"username"`
	Out         string          `json:"out"`
	CountVideos int             `json:"count_videos"`
	CountStills int             `json:"count_stills"`
	Files       []uniqueFileEnt `json:"files"`
	Stills      []uniqueFileEnt `json:"stills"`
}

type uniqueFileEnt struct {
	Dest string `json:"dest"`
	Kind string `json:"kind"`
}

type iganalyzeFile struct {
	Username string           `json:"username"`
	OK       int              `json:"ok"`
	Failed   int              `json:"failed"`
	Skipped  int              `json:"skipped"`
	Total    int              `json:"total"`
	Items    []analyzeItemEnt `json:"items"`
}

type analyzeItemEnt struct {
	Status string `json:"status"`
	Error  string `json:"error"`
}

// DownloadMedia is the M1 download child: one igdl exec step (resume-
// aware) plus a read of data/media/<handle>/manifest.json.
func DownloadMedia(ctx dbos.Context, in ChildStageInput) (DownloadStageResult, error) {
	wfID, _ := dbos.GetWorkflowID(ctx)
	root, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
		return HomeDir()
	}, dbos.WithStepName("download-root"))
	if err != nil {
		return DownloadStageResult{}, err
	}
	profile := in.Scrape.Path
	if profile == "" {
		profile = ProfileJSONPath(root, in.Job.Handle)
	}
	outDir := MediaDir(root, in.Job.Handle)

	_, err = dbos.RunAsStep(ctx, func(sctx context.Context) (CLIResult, error) {
		return RunCLI(sctx, CLISpec{
			Name:        "download-igdl-resume",
			Argv:        igdlArgv(in.Job, profile),
			EnvOverride: EnvIGDLCmd,
			WorkflowID:  wfID,
			Env: []string{
				"IGFLOW_TEST_HANDLE=" + in.Job.Handle,
				"IGFLOW_TEST_OUT=" + outDir,
			},
		})
	}, stepOpts("download-igdl-resume", IGDLRetryPolicy)...)
	if err != nil {
		return DownloadStageResult{}, err
	}

	return dbos.RunAsStep(ctx, func(context.Context) (DownloadStageResult, error) {
		return readDownloadManifest(outDir, in.Scrape.MediaURLs)
	}, dbos.WithStepName("download-read-manifest"), dbos.WithStepMaxRetries(0))
}

func readDownloadManifest(outDir string, mediaURLs int) (DownloadStageResult, error) {
	manPath := filepath.Join(outDir, "manifest.json")
	raw, err := os.ReadFile(manPath)
	if err != nil {
		return DownloadStageResult{}, fmt.Errorf("download: read manifest: %w", err)
	}
	var man igdlManifest
	if err := json.Unmarshal(raw, &man); err != nil {
		return DownloadStageResult{}, fmt.Errorf("download: parse manifest: %w", err)
	}
	res := DownloadStageResult{
		OK:         true,
		Dir:        outDir,
		Attempted:  man.Total,
		Downloaded: man.OK,
		Skipped:    man.Skipped,
		Failed:     man.Failed,
	}
	if mediaURLs == 0 {
		return res, nil
	}
	if man.OK+man.Skipped >= man.Total && man.Total > 0 {
		return res, nil
	}
	if man.OK+man.Skipped >= mediaURLs {
		return res, nil
	}
	if man.Failed > 0 && man.OK == 0 {
		return res, &CLIError{
			Stage:     StageDownload,
			Retryable: true,
			Msg:       fmt.Sprintf("download: every URL failed (%d)", man.Failed),
		}
	}
	return res, &CLIError{
		Stage:     StageDownload,
		Retryable: false,
		Msg:       fmt.Sprintf("download: ok+skipped=%d total=%d mediaUrls=%d", man.OK+man.Skipped, man.Total, mediaURLs),
	}
}

// UniqueMedia is the M1 unique child: ffmpeg/ffprobe pre-step, one
// igunique exec, then read data/<handle>-unique/manifest.json.
func UniqueMedia(ctx dbos.Context, in ChildStageInput) (UniqueStageResult, error) {
	wfID, _ := dbos.GetWorkflowID(ctx)
	root, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
		return HomeDir()
	}, dbos.WithStepName("unique-root"))
	if err != nil {
		return UniqueStageResult{}, err
	}
	profile := in.Scrape.Path
	if profile == "" {
		profile = ProfileJSONPath(root, in.Job.Handle)
	}
	outDir := UniqueDir(root, in.Job.Handle)

	skipTools, err := dbos.RunAsStep(ctx, func(context.Context) (bool, error) {
		return strings.TrimSpace(os.Getenv(EnvIGUniqueCmd)) != "", nil
	}, dbos.WithStepName("unique-skip-tools"), dbos.WithStepMaxRetries(0))
	if err != nil {
		return UniqueStageResult{}, err
	}
	if !skipTools {
		if _, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
			return "", requireMediaTools()
		}, dbos.WithStepName("unique-ffmpeg"), dbos.WithStepMaxRetries(0)); err != nil {
			return UniqueStageResult{}, err
		}
	}

	_, err = dbos.RunAsStep(ctx, func(sctx context.Context) (CLIResult, error) {
		return RunCLI(sctx, CLISpec{
			Name:        StageUnique,
			Argv:        iguniqueArgv(in.Job, profile),
			EnvOverride: EnvIGUniqueCmd,
			WorkflowID:  wfID,
			Env: []string{
				"IGFLOW_TEST_HANDLE=" + in.Job.Handle,
				"IGFLOW_TEST_OUT=" + outDir,
			},
		})
	}, stepOpts(StageUnique, IGUniqueRetryPolicy)...)
	if err != nil {
		return UniqueStageResult{}, err
	}

	return dbos.RunAsStep(ctx, func(context.Context) (UniqueStageResult, error) {
		return readUniqueManifest(outDir)
	}, dbos.WithStepName("unique-read-manifest"), dbos.WithStepMaxRetries(0))
}

func requireMediaTools() error {
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(name); err != nil {
			return &CLIError{
				Stage:     StageUnique,
				Retryable: false,
				Msg:       fmt.Sprintf("%s not on PATH: %v", name, err),
			}
		}
	}
	return nil
}

func readUniqueManifest(outDir string) (UniqueStageResult, error) {
	manPath := filepath.Join(outDir, "manifest.json")
	raw, err := os.ReadFile(manPath)
	if err != nil {
		return UniqueStageResult{}, fmt.Errorf("unique: read manifest: %w", err)
	}
	var man iguniqueManifest
	if err := json.Unmarshal(raw, &man); err != nil {
		return UniqueStageResult{}, fmt.Errorf("unique: parse manifest: %w", err)
	}
	videos := man.CountVideos
	stills := man.CountStills
	if stills == 0 {
		stills = len(man.Stills)
	}
	images := 0
	for _, f := range man.Files {
		if !strings.HasSuffix(strings.ToLower(f.Dest), ".mp4") {
			images++
		}
	}
	if videos == 0 {
		for _, f := range man.Files {
			if strings.HasSuffix(strings.ToLower(f.Dest), ".mp4") {
				videos++
			}
		}
	}
	unique := videos + stills + images
	if unique == 0 {
		unique = len(man.Files) + len(man.Stills)
	}
	dir := man.Out
	if dir == "" {
		dir = outDir
	}
	return UniqueStageResult{
		OK:     true,
		Dir:    dir,
		Videos: videos,
		Stills: stills,
		Images: images,
		Unique: unique,
	}, nil
}

// AnalyzeMedia is the M1 analyze child: one iganalyze exec plus a read
// of data/analysis/<handle>/analysis.json. Provider-level failures and
// ok==0 with total>0 fail closed as Code "llm".
func AnalyzeMedia(ctx dbos.Context, in ChildStageInput) (AnalyzeStageResult, error) {
	wfID, _ := dbos.GetWorkflowID(ctx)
	root, err := dbos.RunAsStep(ctx, func(context.Context) (string, error) {
		return HomeDir()
	}, dbos.WithStepName("analyze-root"))
	if err != nil {
		return AnalyzeStageResult{}, err
	}
	profile := in.Scrape.Path
	if profile == "" {
		profile = ProfileJSONPath(root, in.Job.Handle)
	}
	outDir := AnalysisDir(root, in.Job.Handle)

	_, err = dbos.RunAsStep(ctx, func(sctx context.Context) (CLIResult, error) {
		return RunCLI(sctx, CLISpec{
			Name:        StageAnalyze,
			Argv:        iganalyzeArgv(in.Job, profile),
			EnvOverride: EnvIGAnalyzeCmd,
			WorkflowID:  wfID,
			Env: []string{
				"IGFLOW_TEST_HANDLE=" + in.Job.Handle,
				"IGFLOW_TEST_OUT=" + outDir,
			},
		})
	}, stepOpts(StageAnalyze, IGAnalyzeRetryPolicy)...)
	if err != nil {
		return AnalyzeStageResult{}, err
	}

	return dbos.RunAsStep(ctx, func(context.Context) (AnalyzeStageResult, error) {
		return readAnalyzeFile(outDir)
	}, dbos.WithStepName("analyze-read-manifest"), dbos.WithStepMaxRetries(0))
}

func readAnalyzeFile(outDir string) (AnalyzeStageResult, error) {
	aggPath := filepath.Join(outDir, "analysis.json")
	raw, err := os.ReadFile(aggPath)
	if err != nil {
		return AnalyzeStageResult{}, fmt.Errorf("analyze: read analysis.json: %w", err)
	}
	var man iganalyzeFile
	if err := json.Unmarshal(raw, &man); err != nil {
		return AnalyzeStageResult{}, fmt.Errorf("analyze: parse analysis.json: %w", err)
	}
	res := AnalyzeStageResult{
		OK:           true,
		Dir:          outDir,
		AnalysisPath: aggPath,
		DigestPath:   filepath.Join(outDir, "style-digest.md"),
		Analyzed:     man.OK,
		Failed:       man.Failed,
		Skipped:      man.Skipped,
	}
	if man.OK == 0 && man.Total > 0 {
		return res, &CLIError{
			Stage:     StageAnalyze,
			Retryable: false,
			Code:      "llm",
			Msg:       fmt.Sprintf("analyze: ok=0 total=%d", man.Total),
		}
	}
	for _, it := range man.Items {
		if it.Status == "ok" {
			continue
		}
		if isProviderFailure(it.Error) {
			return res, &CLIError{
				Stage:     StageAnalyze,
				Retryable: false,
				Code:      "llm",
				Msg:       "analyze: provider error: " + it.Error,
			}
		}
	}
	return res, nil
}

func isProviderFailure(msg string) bool {
	low := strings.ToLower(msg)
	for _, n := range []string{
		"401", "403", "2056", "quota", "insufficient_quota",
		"model not found", "model_not_found", "does not exist",
		"unreachable", "connection refused", "no such host",
		"api key", "unauthorized", "forbidden",
	} {
		if strings.Contains(low, n) {
			return true
		}
	}
	return false
}
