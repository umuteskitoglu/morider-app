// Package mail sends transactional email over SMTP.
//
// SMTP rather than a provider SDK: every mail service worth using (Resend,
// SendGrid, Mailgun, Postmark, or a plain Gmail account) speaks it, so the
// deployment picks its provider with four environment variables and the code
// never learns a vendor's API shape.
package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// ErrNotConfigured is returned by Send when no SMTP host is set. Callers treat
// it as "delivery is off", not as a failure of the request that triggered it.
var ErrNotConfigured = errors.New("smtp is not configured")

// dialTimeout bounds the whole conversation: connect, handshake, and the
// DATA transfer. A wedged SMTP server must not pin a goroutine indefinitely.
const dialTimeout = 20 * time.Second

// Sender delivers messages through one SMTP relay.
type Sender struct {
	host     string
	port     int
	username string
	password string
	from     string
	fromName string
}

// Config is the SMTP connection detail, as read from the environment.
type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	FromName string
}

// New builds a Sender. A zero-value Config yields a Sender that reports
// Configured() == false and refuses to send, so services can be wired up
// unconditionally and only the deployment decides whether mail goes out.
func New(cfg Config) *Sender {
	if cfg.Port == 0 {
		cfg.Port = 587
	}
	if cfg.From == "" {
		cfg.From = cfg.Username
	}
	if cfg.FromName == "" {
		cfg.FromName = "Morider"
	}
	return &Sender{
		host:     strings.TrimSpace(cfg.Host),
		port:     cfg.Port,
		username: cfg.Username,
		password: cfg.Password,
		from:     strings.TrimSpace(cfg.From),
		fromName: cfg.FromName,
	}
}

// Configured reports whether this Sender can actually deliver.
func (s *Sender) Configured() bool { return s != nil && s.host != "" && s.from != "" }

// Send delivers a plain-text UTF-8 message to one recipient.
func (s *Sender) Send(ctx context.Context, to, subject, body string) error {
	if !s.Configured() {
		return ErrNotConfigured
	}
	// A CR or LF in the recipient would end the header (or the SMTP verb) and
	// let the rest of the address dictate extra headers or commands. Addresses
	// reach here from the database, so this should never fire — which is
	// exactly why it is cheaper to reject than to reason about every path that
	// could ever write one.
	if strings.ContainsAny(to, "\r\n") {
		return errors.New("mail: recipient contains a line break")
	}

	msg := s.compose(to, subject, body)
	addr := net.JoinHostPort(s.host, fmt.Sprint(s.port))

	// Port 465 is implicit TLS ("SMTPS"): the connection is encrypted before a
	// single SMTP verb is exchanged. Everything else is assumed to be the
	// submission port, which starts in the clear and upgrades via STARTTLS.
	var (
		conn net.Conn
		err  error
	)
	dialer := &net.Dialer{Timeout: dialTimeout}
	if s.port == 465 {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: s.host})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	// One deadline for the entire exchange. net/smtp offers no context support,
	// so this is the only thing that stops a half-open relay hanging the send.
	deadline := time.Now().Add(dialTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp client: %w", err)
	}
	defer client.Close()

	if s.port != 465 {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: s.host}); err != nil {
				return fmt.Errorf("smtp starttls: %w", err)
			}
		}
	}

	// Credentials are only offered once the link is encrypted. smtp.PlainAuth
	// enforces this too, and refuses to authenticate over a cleartext
	// connection — which is the behaviour we want, not something to work
	// around: a relay that wants a password in the clear is misconfigured.
	if s.username != "" {
		if err := client.Auth(smtp.PlainAuth("", s.username, s.password, s.host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}

	if err := client.Mail(s.from); err != nil {
		return fmt.Errorf("smtp from: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		w.Close()
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close body: %w", err)
	}
	return client.Quit()
}

// compose builds the RFC 5322 message. Subject goes through MIME
// encoded-word because Morider's mail is Turkish: a raw "Şifre" in a header is
// non-ASCII, which is illegal there and renders as mojibake in most clients.
func (s *Sender) compose(to, subject, body string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s <%s>\r\n", mime.QEncoding.Encode("utf-8", s.fromName), s.from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	// CRLF line endings throughout the body: a bare LF is what makes some
	// relays mangle or reject the message.
	b.WriteString(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n"))
	return b.String()
}
