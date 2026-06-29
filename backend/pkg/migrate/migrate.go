// Package migrate applies SQL migration files embedded in the binary.
// It tracks applied migrations in a schema_migrations table so each file
// runs exactly once, in filename order.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Run applies all pending *.sql files from fsys against db.
// Files are run in lexicographic order inside a transaction each.
func Run(ctx context.Context, db *pgxpool.Pool, fsys fs.FS) error {
	if _, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("migrate: create tracking table: %w", err)
	}

	rows, err := db.Query(ctx, `SELECT filename FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("migrate: query applied: %w", err)
	}
	applied := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		applied[name] = true
	}
	rows.Close()

	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return fmt.Errorf("migrate: read dir: %w", err)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		if applied[name] {
			continue
		}
		sql, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("migrate: read %s: %w", name, err)
		}
		tx, err := db.Begin(ctx)
		if err != nil {
			return fmt.Errorf("migrate: begin %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("migrate: exec %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (filename) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("migrate: record %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("migrate: commit %s: %w", name, err)
		}
		log.Printf("migrate: applied %s", name)
	}
	return nil
}
