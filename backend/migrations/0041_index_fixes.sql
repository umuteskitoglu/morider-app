-- Morider App - index corrections on the hot write/read paths
--
-- Three separate problems, all found by comparing the declared indexes against
-- the queries that actually run:
--
-- 1. telemetry_points carried a GIST index on geom that NO query reads. Every
--    reader (ride track fetch, segment matching) filters on ride_id and orders
--    by ts. GIST is among the most expensive index types to maintain, and this
--    is the highest-insert-rate table in the system — one row per rider per
--    second. It was pure write amplification.
--
-- 2. The index that IS used, idx_telemetry_ride, omits ts, so every track fetch
--    does an index scan followed by an explicit sort. A three-hour ride is
--    ~10k rows sorted on every request.
--
-- 3. global_messages had no index on user_id at all, so the slow-mode check
--    that runs on EVERY chat message sequentially scanned the entire message
--    history. This degrades continuously as the table grows.
--
-- Plus two duplicate indexes: a UNIQUE column already creates one.
--
-- NOTE ON LOCKING: the migration runner wraps each file in a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside one. On an empty or small
-- database this file is fine as-is. Against a populated production database,
-- run the CONCURRENTLY variants by hand FIRST (see docs/runbook below), then
-- apply this migration — the IF NOT EXISTS / IF EXISTS guards make it a no-op.
--
--   CREATE INDEX CONCURRENTLY idx_telemetry_ride_ts ON telemetry_points(ride_id, ts);
--   DROP INDEX CONCURRENTLY idx_telemetry_ride;
--   DROP INDEX CONCURRENTLY idx_telemetry_geom;
--   CREATE INDEX CONCURRENTLY global_messages_user_created_idx ON global_messages(user_id, created_at DESC);
--   DROP INDEX CONCURRENTLY idx_ride_sessions_code;
--   DROP INDEX CONCURRENTLY idx_events_code;

-- ---------------------------------------------------------------------------
-- 1 + 2. telemetry_points: match the readers, stop paying for an unread index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_telemetry_ride_ts ON telemetry_points (ride_id, ts);
DROP INDEX IF EXISTS idx_telemetry_ride;

-- No spatial query touches telemetry_points.geom. The column stays (segment
-- matching may want it later); only the index cost goes away.
DROP INDEX IF EXISTS idx_telemetry_geom;

-- ---------------------------------------------------------------------------
-- 3. global chat slow mode: WHERE user_id = $1 AND created_at > now() - ...
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS global_messages_user_created_idx
    ON global_messages (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Duplicate indexes: ride_sessions.code and events.code are both declared
--    UNIQUE, which already builds a unique btree. The extra plain index was
--    paying insert/update cost for nothing.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_ride_sessions_code;
DROP INDEX IF EXISTS idx_events_code;
