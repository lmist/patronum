package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type carouselItem struct {
	MediaURL     *string `json:"mediaUrl"`
	ThumbnailURL *string `json:"thumbnailUrl"`
	IsVideo      *bool   `json:"isVideo"`
}

type downloadEntry struct {
	URL    string `json:"url"`
	Local  string `json:"localPath"`
	Status string `json:"status"`
}

func assetKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.Path
}

func readMediaIndex(dir string) (map[string][]string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var man struct {
		Results []downloadEntry   `json:"results"`
		ByURL   map[string]string `json:"byUrl"`
	}
	if err = json.Unmarshal(b, &man); err != nil {
		return nil, err
	}
	index := map[string][]string{}
	base, _ := filepath.Abs(dir)
	add := func(u, p string) {
		key := assetKey(u)
		if key == "" || p == "" {
			return
		}
		abs, _ := filepath.Abs(p)
		rel, err := filepath.Rel(base, abs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return
		}
		for _, old := range index[key] {
			if old == p {
				return
			}
		}
		index[key] = append(index[key], p)
	}
	for _, r := range man.Results {
		if r.Status == "ok" || r.Status == "skipped" {
			add(r.URL, r.Local)
		}
	}
	for u, p := range man.ByURL {
		add(u, p)
	}
	return index, nil
}

// Resolve ownership before ranking quality. A legacy image row may contain
// recommendations in mediaUrls/carouselMedia; only its grid cover is trusted.
func selectPostMedia(it mediaItem, index map[string][]string) ([]probeInfo, error) {
	groups := [][]string{}
	if it.MediaOwnershipVersion == 1 {
		if len(it.CarouselMedia) > 0 {
			for _, slide := range it.CarouselMedia {
				groups = append(groups, []string{deref(slide.MediaURL), deref(slide.ThumbnailURL)})
			}
		} else {
			groups = append(groups, append(append([]string{}, it.MediaURLs...), deref(it.ThumbnailURL)))
		}
	} else if itemKind(it) == "carousel" || isReelOrVideoItem(it) {
		return nil, fmt.Errorf("%s: legacy video/carousel has no verified media ownership; collect this post again", itemShortcode(it))
	} else if it.ThumbnailURL != nil {
		groups = append(groups, []string{*it.ThumbnailURL})
	} else {
		return nil, fmt.Errorf("%s: no verified media or cover; collect this post again", itemShortcode(it))
	}
	seen := map[string]bool{}
	out := []probeInfo{}
	for _, group := range groups {
		candidates := []probeInfo{}
		paths := map[string]bool{}
		for _, u := range group {
			variants := index[assetKey(u)]
			localVariants := []string{}
			for _, p := range variants {
				if filepath.Base(filepath.Dir(p)) == itemShortcode(it) {
					localVariants = append(localVariants, p)
				}
			}
			if len(localVariants) > 0 {
				variants = localVariants
			}
			for _, p := range variants {
				if paths[p] {
					continue
				}
				paths[p] = true
				info, err := probe(p)
				if err != nil {
					continue
				}
				ext := strings.ToLower(filepath.Ext(p))
				isImage := ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp"
				if !isImage && !isPlayable(info) {
					continue
				}
				if info.Width < 16 || info.Height < 16 || info.SHA == "" {
					continue
				}
				candidates = append(candidates, info)
			}
		}
		sort.SliceStable(candidates, func(i, j int) bool {
			vi, vj := isPlayable(candidates[i]), isPlayable(candidates[j])
			if vi != vj {
				return vi
			}
			a, b := candidates[i], candidates[j]
			if a.Width*a.Height != b.Width*b.Height {
				return a.Width*a.Height > b.Width*b.Height
			}
			if a.Bytes != b.Bytes {
				return a.Bytes > b.Bytes
			}
			return a.Path < b.Path
		})
		if len(candidates) == 0 {
			return nil, fmt.Errorf("%s: no downloaded file matches an owned media asset", itemShortcode(it))
		}
		best := candidates[0]
		if !seen[best.SHA] {
			seen[best.SHA] = true
			out = append(out, best)
		}
	}
	return out, nil
}

// Retire files from the previous manifest that the new selection no longer
// references. Keep them recoverable outside the active unique directory.
func archiveSuperseded(outDir string, previous []byte, keep map[string]bool) error {
	var old outManifest
	if len(previous) == 0 {
		return nil
	}
	if err := json.Unmarshal(previous, &old); err != nil {
		return err
	}
	archive := ""
	for _, f := range append(old.Files, old.Stills...) {
		name := filepath.Base(f.Dest)
		if keep[name] {
			continue
		}
		p := filepath.Join(outDir, name)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			continue
		}
		if archive == "" {
			parent := outDir + "-archive"
			if err := os.MkdirAll(parent, 0755); err != nil {
				return err
			}
			var err error
			archive, err = os.MkdirTemp(parent, "superseded-")
			if err != nil {
				return err
			}
			if err = os.WriteFile(filepath.Join(archive, "manifest.json"), previous, 0644); err != nil {
				return err
			}
		}
		if err := os.Rename(p, filepath.Join(archive, name)); err != nil {
			return err
		}
	}
	if archive != "" {
		fmt.Printf("igunique: archived superseded files in %s\n", archive)
	}
	return nil
}
