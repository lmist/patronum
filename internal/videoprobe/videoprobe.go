// Package videoprobe asks ffprobe one question about a media file: does it
// contain real video, and how much?
//
// A file can have a video name and even advertise a video stream while holding
// no pictures at all (a DASH initialization file, or a fragment that cannot be
// read without its init file). The functions here look past the name:
//
//   - Describe reports the first video stream's size, codec and container, and
//     whether at least one video packet can actually be read.
//   - HasVideoPackets answers only the yes/no part of that.
//   - CountFrames decodes the whole first video stream and counts its frames.
//
// All of them run the ffprobe binary found on PATH.
package videoprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	firstPacketTimeout = 15 * time.Second
	countFramesTimeout = 30 * time.Second

	describeEntries = "stream=width,height,codec_name,codec_type,nb_read_packets:format=format_name,duration"
	packetEntries   = "stream=nb_read_packets"
)

// Info describes the first video stream of a file and its container.
// Fields ffprobe did not report are left at their zero value.
type Info struct {
	Width      int
	Height     int
	Codec      string  // ffprobe codec_name, e.g. "h264"
	StreamType string  // ffprobe codec_type, e.g. "video"
	Packets    int     // video packets read from the first packet interval: 0 or 1
	Format     string  // ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
	Duration   float64 // seconds
}

// Describe reads the first video stream's metadata and tries to read one video
// packet from it. The error is ffprobe's own (or the JSON decoding error),
// returned unwrapped.
func Describe(path string) (Info, error) {
	out, err := readFirstPacket(path, describeEntries)
	if err != nil {
		return Info{}, err
	}
	return parseDescribe(out)
}

// HasVideoPackets reports whether at least one video packet can be read from
// the file's first video stream. Any failure counts as "no".
func HasVideoPackets(path string) bool {
	out, err := readFirstPacket(path, packetEntries)
	if err != nil {
		return false
	}
	return parseHasPackets(out)
}

// CountFrames decodes the first video stream and returns its frame count,
// which is always at least 1 when the error is nil.
func CountFrames(path string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), countFramesTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
		"-show_entries", "stream=nb_read_frames", "-of", "default=noprint_wrappers=1:nokey=1", path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("ffprobe frame count: %v: %s", err, truncate(string(output), 240))
	}
	return parseFrameCount(string(output))
}

// readFirstPacket runs the probe shared by Describe and HasVideoPackets: read
// at most one packet of the first video stream and print the given entries as
// JSON. Only the list of entries differs between the two callers.
func readFirstPacket(path, entries string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), firstPacketTimeout)
	defer cancel()
	return exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0",
		"-count_packets", "-read_intervals", "%+#1",
		"-show_entries", entries,
		"-of", "json", path).Output()
}

type firstPacketJSON struct {
	Streams []struct {
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		CodecName string `json:"codec_name"`
		CodecType string `json:"codec_type"`
		Packets   string `json:"nb_read_packets"`
	} `json:"streams"`
	Format struct {
		Name     string `json:"format_name"`
		Duration string `json:"duration"`
	} `json:"format"`
}

func parseDescribe(out []byte) (Info, error) {
	var p firstPacketJSON
	if err := json.Unmarshal(out, &p); err != nil {
		return Info{}, err
	}
	var info Info
	if len(p.Streams) > 0 {
		info.Width = p.Streams[0].Width
		info.Height = p.Streams[0].Height
		info.Codec = p.Streams[0].CodecName
		info.StreamType = p.Streams[0].CodecType
		info.Packets, _ = strconv.Atoi(p.Streams[0].Packets)
	}
	info.Format = p.Format.Name
	if p.Format.Duration != "" {
		if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil {
			info.Duration = d
		}
	}
	return info, nil
}

func parseHasPackets(out []byte) bool {
	var p firstPacketJSON
	if json.Unmarshal(out, &p) != nil {
		return false
	}
	for _, stream := range p.Streams {
		if n, err := strconv.Atoi(stream.Packets); err == nil && n > 0 {
			return true
		}
	}
	return false
}

func parseFrameCount(output string) (int, error) {
	for _, field := range strings.Fields(output) {
		if count, err := strconv.Atoi(field); err == nil && count > 0 {
			return count, nil
		}
	}
	return 0, fmt.Errorf("ffprobe found no video frames")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
