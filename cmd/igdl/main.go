// igdl downloads media URLs from a scrape-profile JSON file.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lmist/patronum/internal/home"
	"github.com/lmist/patronum/internal/igdl"
)

func main() {
	inPath := flag.String("in", "", "path to profile JSON from scrape-profile")
	outDir := flag.String("out", "", "output directory (default: data/media/<username>)")
	workers := flag.Int("workers", 15, "number of concurrent download workers")
	fresh := flag.Bool("fresh", false, "ignore existing manifest and re-download everything")
	reorgOnly := flag.Bool("reorg", false, "move existing flat files into per-post directories and exit")
	skipReels := flag.Bool("skip-reels", false, "skip reels and standalone videos; image + carousel posts only")
	flag.Parse()

	if *reorgOnly {
		if *outDir == "" {
			fmt.Fprintln(os.Stderr, "error: -reorg requires -out <media dir>")
			flag.Usage()
			os.Exit(2)
		}
		moved, err := igdl.ReorganizeOutDir(*outDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: reorg: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("igdl: reorg — moved %d file(s) into per-post directories under %s\n", moved, *outDir)
		os.Exit(0)
	}

	if *inPath == "" {
		fmt.Fprintln(os.Stderr, "error: -in <profile.json> is required")
		flag.Usage()
		os.Exit(2)
	}
	if *workers < 1 {
		*workers = 1
	}

	raw, err := os.ReadFile(*inPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: read -in: %v\n", err)
		os.Exit(1)
	}

	var profile igdl.ProfileJSON
	if err := json.Unmarshal(raw, &profile); err != nil {
		fmt.Fprintf(os.Stderr, "error: parse profile JSON: %v\n", err)
		os.Exit(1)
	}

	username := profile.Username
	if username == "" {
		username = "unknown"
	}
	if *outDir == "" {
		*outDir = home.Path("data", "media", username)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "error: mkdir out: %v\n", err)
		os.Exit(1)
	}

	if moved, err := igdl.ReorganizeOutDir(*outDir); err != nil {
		fmt.Fprintf(os.Stderr, "error: reorg: %v\n", err)
		os.Exit(1)
	} else if moved > 0 {
		fmt.Printf("igdl: reorg — moved %d existing file(s) into per-post directories\n", moved)
	}

	// Resume: load prior successful URL → path map from manifest.json
	priorOK := map[string]string{}
	if !*fresh {
		priorOK = igdl.LoadPriorOK(*outDir)
		if len(priorOK) > 0 {
			fmt.Printf("igdl: resume — %d URL(s) already on disk (from manifest)\n", len(priorOK))
		}
	} else {
		fmt.Println("igdl: --fresh — re-downloading all URLs")
		// DownloadOne honors manifest entries for retry safety; fresh deliberately ignores them.
		_ = os.Remove(filepath.Join(*outDir, "manifest.json"))
	}

	jobs := igdl.CollectJobs(&profile, *skipReels)
	jobs = igdl.DedupeJobs(jobs)
	if *skipReels {
		fmt.Println("igdl: -skip-reels — image + carousel posts only")
	}

	var resumeSkipped []igdl.Result
	var pending []igdl.Job
	for _, j := range jobs {
		if local, ok := priorOK[j.URL]; ok && !*fresh {
			// Confirm file still exists
			if st, err := os.Stat(local); err == nil && st.Size() > 0 {
				resumeSkipped = append(resumeSkipped, igdl.Result{
					URL:      j.URL,
					Local:    local,
					Status:   "skipped",
					Error:    "already downloaded (resume)",
					Filename: filepath.Base(local),
					Bytes:    st.Size(),
				})
				continue
			}
		}
		pending = append(pending, j)
	}

	if len(jobs) == 0 {
		fmt.Println("no media URLs found in profile JSON")
		igdl.WriteManifest(*outDir, username, *workers, nil, time.Now(), time.Now())
		printIGDLJSON(*outDir, 0, 0, 0, 0, true)
		os.Exit(0)
	}

	fmt.Printf("igdl: %d unique URL(s) (%d pending, %d resume-skip) → %s (%d workers)\n",
		len(jobs), len(pending), len(resumeSkipped), *outDir, *workers)

	started := time.Now()
	var downloaded []igdl.Result
	if len(pending) > 0 {
		downloaded = runPool(pending, *outDir, *workers)
	}
	ended := time.Now()

	// Merge: keep prior OK entries for URLs not re-fetched, plus new results
	merged := igdl.MergeResults(priorOK, resumeSkipped, downloaded, *fresh)

	var okN, skipN, failN int
	for _, r := range merged {
		switch r.Status {
		case "ok":
			okN++
		case "skipped":
			skipN++
		default:
			failN++
		}
	}

	manPath, err := igdl.WriteManifest(*outDir, username, *workers, merged, started, ended)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: write manifest: %v\n", err)
	} else {
		fmt.Printf("manifest: %s\n", manPath)
	}

	fmt.Printf("done: ok=%d skipped=%d failed=%d total=%d\n", okN, skipN, failN, len(merged))

	// Exit non-zero only if all pending failed (and there was pending work).
	pendingFail := 0
	pendingOK := 0
	for _, r := range downloaded {
		if r.Status == "ok" {
			pendingOK++
		} else if r.Status != "skipped" {
			pendingFail++
		}
	}
	allPendingFailed := len(pending) > 0 && pendingFail > 0 && pendingOK == 0
	if !allPendingFailed {
		printIGDLJSON(*outDir, len(merged), okN, skipN, failN, true)
	}
	if allPendingFailed {
		os.Exit(1)
	}
}

func printIGDLJSON(dir string, attempted, okN, skipN, failN int, ok bool) {
	b, _ := json.Marshal(map[string]any{
		"ok": ok, "dir": dir, "downloaded": okN, "skipped": skipN,
		"failed": failN, "attempted": attempted,
	})
	fmt.Println(string(b))
}

func runPool(jobs []igdl.Job, outDir string, workers int) []igdl.Result {
	jobCh := make(chan igdl.Job)
	resCh := make(chan igdl.Result)
	var done atomic.Int64
	total := int64(len(jobs))

	client := &http.Client{
		Timeout: 90 * time.Second,
		// Follow redirects
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			// keep browser-like headers on redirect
			req.Header.Set("User-Agent", userAgent)
			req.Header.Set("Referer", "https://www.instagram.com/")
			return nil
		},
	}

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobCh {
				resCh <- igdl.DownloadOne(client, outDir, j)
				n := done.Add(1)
				if n%5 == 0 || n == total {
					fmt.Printf("progress: %d/%d\n", n, total)
				}
			}
		}()
	}

	// Single result collector
	results := make([]igdl.Result, 0, len(jobs))
	var collectWg sync.WaitGroup
	collectWg.Add(1)
	go func() {
		defer collectWg.Done()
		for r := range resCh {
			results = append(results, r)
			if r.Status == "ok" {
				fmt.Printf("  ok  %s → %s\n", truncate(r.URL, 60), r.Filename)
			} else if r.Status == "skipped" {
				fmt.Printf("  skip %s (%s)\n", truncate(r.URL, 60), r.Error)
			} else {
				fmt.Printf("  err  %s: %s\n", truncate(r.URL, 60), r.Error)
			}
		}
	}()

	for _, j := range jobs {
		jobCh <- j
	}
	close(jobCh)
	wg.Wait()
	close(resCh)
	collectWg.Wait()

	return results
}

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
