-- Maintenance schedules: per-motorcycle service intervals (oil, tyres, chain,
-- brakes, ...) by distance and/or time. "Due in km" is derived from the bike's
-- latest known odometer (service_records / fuel_logs); "due in days" from
-- last_done_at + interval_months. On-device reminders fire as the item nears due.
CREATE TABLE IF NOT EXISTS maintenance_schedules (
    id              BIGSERIAL   PRIMARY KEY,
    motorcycle_id   BIGINT      NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
    item            TEXT        NOT NULL,        -- "Motor yağı", "Zincir", "Ön lastik" ...
    interval_km     INT,                         -- service every N km (null = time-only)
    interval_months INT,                         -- service every N months (null = distance-only)
    last_done_km    INT,                         -- odometer at last service
    last_done_at    DATE,                        -- date of last service
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_moto ON maintenance_schedules(motorcycle_id);
