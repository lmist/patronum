package flow

import (
	"bytes"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var secretName = regexp.MustCompile(`(?i)(password|passwd|(^|_)pass$|secret|token|api_?key|cookie|authorization)`)
var authValue = regexp.MustCompile(`(?i)((?:"?(?:password|passwd|ig_pass|api[_-]?key|access[_-]?token|refresh[_-]?token|sessionid|csrftoken|totp[_-]?secret|verification[_-]?code)"?\s*[:=]\s*"?))([^"\s,;}]+)`)
var bearerValue = regexp.MustCompile(`(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+`)
var codeValue = regexp.MustCompile(`(?i)((?:"?(?:code|otp|totp)"?\s*[:=]\s*"?))[0-9]{4,8}\b`)
var apiToken = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{12,}`)
var cookieHeader = regexp.MustCompile(`(?i)((?:set-cookie|cookie|authorization)\s*:\s*).+`)

func logRedactor(env []string) func(string) string {
	var secrets []string
	for _, pair := range env {
		key, value, ok := strings.Cut(pair, "=")
		if ok && value != "" && secretName.MatchString(key) {
			secrets = append(secrets, value)
			quoted := strconv.Quote(value)
			if quoted[1:len(quoted)-1] != value {
				secrets = append(secrets, quoted[1:len(quoted)-1])
			}
		}
	}
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	return func(s string) string {
		for _, secret := range secrets {
			s = strings.ReplaceAll(s, secret, "[REDACTED]")
		}
		s = bearerValue.ReplaceAllString(s, "${1}[REDACTED]")
		s = authValue.ReplaceAllString(s, "${1}[REDACTED]")
		s = codeValue.ReplaceAllString(s, "${1}[REDACTED]")
		s = apiToken.ReplaceAllString(s, "[REDACTED]")
		return cookieHeader.ReplaceAllString(s, "${1}[REDACTED]")
	}
}

// stageLog serializes both subprocess streams into complete timestamped records.
// Raw stdout reaches the classifier before redaction; only safe text is persisted.
type stageLog struct {
	mu     sync.Mutex
	file   io.Writer
	mirror io.Writer
	name   string
	redact func(string) string
}

func (l *stageLog) write(stream, message string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	message = strings.ReplaceAll(strings.ReplaceAll(l.redact(message), "\r", "\\r"), "\n", "\\n")
	line := fmt.Sprintf("%s [igflow:%s] [%s] %s\n", time.Now().UTC().Format(time.RFC3339Nano), l.name, stream, message)
	if _, err := io.WriteString(l.file, line); err != nil {
		return err
	}
	if l.mirror != nil {
		_, _ = io.WriteString(l.mirror, line)
	}
	return nil
}

type stageStream struct {
	log     *stageLog
	name    string
	tail    *lastJSONLine
	pending []byte
}

func (s *stageStream) Write(p []byte) (int, error) {
	s.pending = append(s.pending, p...)
	for {
		i := bytes.IndexByte(s.pending, '\n')
		if i < 0 {
			break
		}
		line := s.pending[:i]
		if s.tail != nil {
			s.tail.set(line)
		}
		if err := s.log.write(s.name, string(line)); err != nil {
			return 0, err
		}
		s.pending = s.pending[i+1:]
	}
	return len(p), nil
}

func (s *stageStream) flush() error {
	if len(s.pending) == 0 {
		return nil
	}
	if s.tail != nil {
		s.tail.set(s.pending)
	}
	err := s.log.write(s.name, string(s.pending))
	s.pending = nil
	return err
}
