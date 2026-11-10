package videoprobe

import "testing"

// These tests cover only the parsing of ffprobe output, so they run without
// ffprobe installed.

func TestParseDescribe(t *testing.T) {
	out := []byte(`{"streams":[{"codec_name":"h264","codec_type":"video","width":960,"height":720,"nb_read_packets":"1"}],
		"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"0.200000"}}`)
	got, err := parseDescribe(out)
	if err != nil {
		t.Fatal(err)
	}
	want := Info{Width: 960, Height: 720, Codec: "h264", StreamType: "video", Packets: 1,
		Format: "mov,mp4,m4a,3gp,3g2,mj2", Duration: 0.2}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseDescribeTolerantOfMissingValues(t *testing.T) {
	got, err := parseDescribe([]byte(`{"streams":[],"format":{"format_name":"mp4","duration":"N/A"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := (Info{Format: "mp4"}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if _, err := parseDescribe([]byte("not json")); err == nil {
		t.Fatal("want an error for output that is not JSON")
	}
}

func TestParseHasPackets(t *testing.T) {
	for _, tc := range []struct {
		out  string
		want bool
	}{
		{`{"streams":[{"nb_read_packets":"1"}]}`, true},
		{`{"streams":[{"nb_read_packets":"0"}]}`, false},
		{`{"streams":[{"nb_read_packets":"N/A"}]}`, false},
		{`{"streams":[{}]}`, false},
		{`{"streams":[]}`, false},
		{`not json`, false},
	} {
		if got := parseHasPackets([]byte(tc.out)); got != tc.want {
			t.Errorf("parseHasPackets(%s) = %v, want %v", tc.out, got, tc.want)
		}
	}
}

func TestParseFrameCount(t *testing.T) {
	if got, err := parseFrameCount("N/A\n6\n"); err != nil || got != 6 {
		t.Fatalf("got %d, %v; want 6, nil", got, err)
	}
	for _, output := range []string{"", "0\n", "N/A\n"} {
		_, err := parseFrameCount(output)
		if err == nil || err.Error() != "ffprobe found no video frames" {
			t.Errorf("parseFrameCount(%q) error = %v", output, err)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("abcdef", 4); got != "abc…" {
		t.Fatalf("got %q", got)
	}
	if got := truncate("abc", 4); got != "abc" {
		t.Fatalf("got %q", got)
	}
}
