// Package logger provides a small wrapper around zerolog for structured logs.
package logger

import (
	"os"
	"time"

	"github.com/rs/zerolog"
)

// New returns a structured logger tagged with the service name.
func New(service string) zerolog.Logger {
	return zerolog.New(os.Stdout).
		With().
		Timestamp().
		Str("service", service).
		Logger()
}

func init() {
	zerolog.TimeFieldFormat = time.RFC3339
}
