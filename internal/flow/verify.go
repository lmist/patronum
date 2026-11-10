package flow

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// VerifyInput is the plain-function input for VerifyProfile.
type VerifyInput struct {
	Path      string
	Handle    string
	SkipReels bool
	SHA256    string
}

const (
	markerContinuingPublic = "continuing public"
	markerDOMOnly          = "dom-only"
	markerForceLoginFailed = "force-login failed"
)

// VerifyProfile is a deterministic, retry-free check over a scrape JSON
// file. Real=false is returned as an error so ScrapeJob fails closed
// before download.
func VerifyProfile(_ context.Context, in VerifyInput) (VerifyStageResult, error) {
	res := VerifyStageResult{}
	path := strings.TrimSpace(in.Path)
	handle := strings.TrimSpace(in.Handle)
	if path == "" {
		return failVerify(res, "verify: empty profile path")
	}
	if handle == "" {
		return failVerify(res, "verify: empty handle")
	}

	slash := filepath.ToSlash(path)
	if !strings.Contains(slash, "data/profiles/") {
		return failVerify(res, fmt.Sprintf("verify: path %q is not under data/profiles/", path))
	}
	if !strings.Contains(strings.ToLower(slash), strings.ToLower(handle)) {
		return failVerify(res, fmt.Sprintf("verify: path %q does not contain handle %q", path, handle))
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return failVerify(res, fmt.Sprintf("verify: read %s: %v", path, err))
	}

	if in.SHA256 != "" {
		sum, herr := hashFileSHA256(path)
		if herr != nil {
			return failVerify(res, fmt.Sprintf("verify: hash %s: %v", path, herr))
		}
		if !strings.EqualFold(sum, in.SHA256) {
			return failVerify(res, fmt.Sprintf("verify: sha256 mismatch for %s", path))
		}
	}

	var prof profileFile
	if err := json.Unmarshal(raw, &prof); err != nil {
		return failVerify(res, fmt.Sprintf("verify: parse %s: %v", path, err))
	}

	if !strings.EqualFold(strings.TrimSpace(prof.Username), handle) {
		return failVerify(res, fmt.Sprintf("verify: json username %q != handle %q", prof.Username, handle))
	}
	if prof.Partial {
		return failVerify(res, "verify: profile JSON has partial=true (checkpoint, not a finished scrape)")
	}

	notes := prof.Notes.currentRun()
	lowNotes := strings.ToLower(notes)
	for _, marker := range []string{markerContinuingPublic, markerDOMOnly, markerForceLoginFailed} {
		if strings.Contains(lowNotes, marker) {
			return failVerify(res, fmt.Sprintf("verify: notes contain removed fallback %q", marker))
		}
	}
	if prof.Session.Authenticated != nil {
		if !*prof.Session.Authenticated {
			return failVerify(res, "verify: session.authenticated is false")
		}
	} else if !prof.OK || prof.Session.DidLogin == nil {
		// Legacy completed scrapes assert authentication before collecting data.
		// didLogin=false means the authenticated session reused saved cookies.
		return failVerify(res, "verify: missing authentication evidence (legacy ok/session.didLogin)")
	}

	items := append(append([]profileItem{}, prof.Posts...), prof.Reels...)
	res.Items = len(items)
	res.Reels = len(prof.Reels)
	empty := 0
	for _, it := range items {
		if len(it.MediaURLs) == 0 && strings.TrimSpace(it.ThumbnailURL) == "" {
			empty++
		}
	}
	res.EmptyMedia = empty
	limit := math.Max(2, 0.1*float64(len(items)))
	if float64(empty) > limit {
		return failVerify(res, fmt.Sprintf("verify: empty media on %d/%d items (limit %.1f)", empty, len(items), limit))
	}

	if in.SkipReels {
		if len(prof.Reels) != 0 {
			return failVerify(res, fmt.Sprintf("verify: skipReels but reels=%d", len(prof.Reels)))
		}
		for _, it := range prof.Posts {
			if isReelOrVideoPost(it) {
				return failVerify(res, fmt.Sprintf("verify: skipReels but post %s is a reel/video", it.Shortcode))
			}
		}
	}

	res.OK = true
	res.Real = true
	res.Evidence = fmt.Sprintf(
		"username=%s items=%d emptyMedia=%d reels=%d sha=ok",
		prof.Username, res.Items, res.EmptyMedia, res.Reels,
	)
	return res, nil
}

func failVerify(res VerifyStageResult, evidence string) (VerifyStageResult, error) {
	res.OK = false
	res.Real = false
	res.Evidence = evidence
	return res, fmt.Errorf("%s", evidence)
}

type profileFile struct {
	OK       bool           `json:"ok"`
	Username string         `json:"username"`
	Partial  bool           `json:"partial"`
	Notes    notesField     `json:"notes"`
	Session  profileSession `json:"session"`
	Posts    []profileItem  `json:"posts"`
	Reels    []profileItem  `json:"reels"`
}

type profileSession struct {
	Authenticated *bool `json:"authenticated"`
	DidLogin      *bool `json:"didLogin"`
}

type profileItem struct {
	Shortcode    string   `json:"shortcode"`
	Type         string   `json:"type"`
	Permalink    string   `json:"permalink"`
	MediaURLs    []string `json:"mediaUrls"`
	ThumbnailURL string   `json:"thumbnailUrl"`
	IsVideo      *bool    `json:"isVideo"`
}

// isReelOrVideoPost matches src/cmd/scrape-profile.ts: type reel/video,
// /reel/ permalink, or isVideo. Image and carousel stay false even when
// isVideo is set (carousel clips are kept with --skip-reels).
func isReelOrVideoPost(it profileItem) bool {
	t := strings.ToLower(strings.TrimSpace(it.Type))
	if t == "carousel" || t == "image" || t == "photo" {
		return false
	}
	if t == "reel" || t == "video" {
		return true
	}
	if strings.Contains(strings.ToLower(it.Permalink), "/reel/") {
		return true
	}
	if it.IsVideo != nil && *it.IsVideo {
		return true
	}
	return false
}

type notesField []string

func (n *notesField) UnmarshalJSON(b []byte) error {
	if string(b) == "null" || len(b) == 0 {
		*n = nil
		return nil
	}
	var arr []string
	if err := json.Unmarshal(b, &arr); err == nil {
		*n = arr
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		if s != "" {
			*n = []string{s}
		}
		return nil
	}
	*n = nil
	return nil
}

func (n notesField) joined() string {
	return strings.Join(n, "\n")
}

// currentRun joins notes from this scrape. Lines copied forward as
// "[prior] …" are provenance; they must not fail a later authenticated run.
func (n notesField) currentRun() string {
	var parts []string
	for _, s := range n {
		t := strings.TrimSpace(s)
		if t == "" || strings.HasPrefix(strings.ToLower(t), "[prior]") {
			continue
		}
		parts = append(parts, t)
	}
	return strings.Join(parts, "\n")
}
