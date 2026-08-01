package mail

import (
	"context"
	"strings"
	"testing"
)

func TestConfiguredRequiresHostAndFrom(t *testing.T) {
	cases := map[string]struct {
		cfg  Config
		want bool
	}{
		"empty":              {Config{}, false},
		"host only":          {Config{Host: "smtp.example.com"}, false},
		"from only":          {Config{From: "no-reply@morider.app"}, false},
		"host and from":      {Config{Host: "smtp.example.com", From: "no-reply@morider.app"}, true},
		"from falls back to": {Config{Host: "smtp.example.com", Username: "no-reply@morider.app"}, true},
	}
	for name, tc := range cases {
		if got := New(tc.cfg).Configured(); got != tc.want {
			t.Errorf("%s: Configured() = %v, want %v", name, got, tc.want)
		}
	}
}

func TestSendWithoutConfigReportsNotConfigured(t *testing.T) {
	err := New(Config{}).Send(context.Background(), "rider@example.com", "hi", "body")
	if err != ErrNotConfigured {
		t.Fatalf("Send() = %v, want ErrNotConfigured", err)
	}
}

// TestSendRejectsHeaderInjection covers the case where a recipient address
// carries a line break: without the guard it would terminate the To: header and
// let the remainder inject further headers (Bcc, say) into the message.
func TestSendRejectsHeaderInjection(t *testing.T) {
	s := New(Config{Host: "smtp.example.com", From: "no-reply@morider.app"})
	err := s.Send(context.Background(), "rider@example.com\r\nBcc: attacker@evil.test", "hi", "body")
	if err == nil {
		t.Fatal("Send() accepted a recipient containing CRLF")
	}
	if err == ErrNotConfigured {
		t.Fatal("Send() rejected on configuration, not on the line break")
	}
}

// TestComposeEncodesNonASCIISubject guards the Turkish subject lines. A raw
// "Şifre" byte in a header is illegal per RFC 5322 and renders as mojibake;
// MIME encoded-word is what makes it display correctly.
func TestComposeEncodesNonASCIISubject(t *testing.T) {
	s := New(Config{Host: "smtp.example.com", From: "no-reply@morider.app"})
	msg := s.compose("rider@example.com", "Morider şifre sıfırlama kodun", "kod: 123456")

	subject := headerLine(t, msg, "Subject: ")
	if strings.Contains(subject, "ş") {
		t.Fatalf("subject header carries raw non-ASCII: %q", subject)
	}
	if !strings.HasPrefix(subject, "=?utf-8?") {
		t.Fatalf("subject is not MIME encoded: %q", subject)
	}
}

// TestComposeUsesCRLFLineEndings guards against a body written with bare LFs,
// which some relays mangle or reject outright.
func TestComposeUsesCRLFLineEndings(t *testing.T) {
	s := New(Config{Host: "smtp.example.com", From: "no-reply@morider.app"})
	msg := s.compose("rider@example.com", "hi", "first\nsecond\r\nthird")

	for i, r := range msg {
		if r == '\n' && (i == 0 || msg[i-1] != '\r') {
			t.Fatalf("message contains a bare LF at offset %d", i)
		}
	}
	if !strings.Contains(msg, "first\r\nsecond\r\nthird") {
		t.Fatal("body line endings were not normalised to CRLF")
	}
}

func headerLine(t *testing.T, msg, prefix string) string {
	t.Helper()
	for _, line := range strings.Split(msg, "\r\n") {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimPrefix(line, prefix)
		}
	}
	t.Fatalf("no %q header in message", prefix)
	return ""
}
