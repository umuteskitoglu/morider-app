-- Morider App - fuzzy user search via trigram similarity (typo-tolerant,
-- partial-match "near" search). Powers /api/users/search.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index accelerates both ILIKE substring and similarity() lookups.
CREATE INDEX IF NOT EXISTS idx_users_name_trgm ON users USING gin (name gin_trgm_ops);
