-- Morider App - SOS events
--
-- Crash alerts used to exist only as a WebSocket frame: the phone told whoever
-- happened to have the group screen open, and nothing was written down. If the
-- rider was in a dead zone, backgrounded, or alone, the alert went nowhere and
-- left no trace.
--
-- An SOS is now a durable record. The client can retry it when signal comes
-- back, responders can be notified out-of-band (push today, SMS once a
-- provider is configured), and the event stays queryable afterwards — both for
-- the rider ("was help actually called?") and for support.

CREATE TABLE IF NOT EXISTS sos_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set when the SOS happened during a group ride, so responders can be scoped
  -- to the people actually riding with them.
  session_id   BIGINT      REFERENCES ride_sessions(id) ON DELETE SET NULL,
  -- Location is optional on purpose: a crash seconds after launch may have no
  -- fix yet, and reporting 0,0 would point rescuers at the Gulf of Guinea.
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  accuracy_m   DOUBLE PRECISION,
  battery_pct  INT,
  -- 'crash' (auto-detected) or 'manual' (rider pressed the button).
  source       TEXT        NOT NULL DEFAULT 'crash',
  -- Device tokens the push was addressed to. Delivery is asynchronous and not
  -- confirmed here, so 0 means "nobody to tell", not "nobody got it".
  notified     INT         NOT NULL DEFAULT 0,
  -- The client generates this so a retried SOS doesn't create duplicates.
  client_id    TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the rider cancels ("false alarm") or confirms they're safe.
  resolved_at  TIMESTAMPTZ
);

-- Retries of the same incident collapse onto one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sos_client_id ON sos_events (user_id, client_id);
CREATE INDEX IF NOT EXISTS idx_sos_user_created ON sos_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_unresolved ON sos_events (created_at DESC) WHERE resolved_at IS NULL;
