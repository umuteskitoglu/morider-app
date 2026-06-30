-- Fuel & range: per-motorcycle tank/consumption metadata plus a fuel log used to
-- derive real-world consumption (full-to-full method) and remaining range.
ALTER TABLE motorcycles ADD COLUMN IF NOT EXISTS tank_liters     DOUBLE PRECISION; -- usable tank capacity (L)
ALTER TABLE motorcycles ADD COLUMN IF NOT EXISTS avg_consumption DOUBLE PRECISION; -- L/100km, auto-derived from full fills
ALTER TABLE motorcycles ADD COLUMN IF NOT EXISTS fuel_type       TEXT;             -- "benzin", "dizel", "elektrik" ...

CREATE TABLE IF NOT EXISTS fuel_logs (
    id            BIGSERIAL        PRIMARY KEY,
    motorcycle_id BIGINT           NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
    liters        DOUBLE PRECISION NOT NULL,            -- litres added at this fill
    cost          DOUBLE PRECISION,                     -- total paid (currency-agnostic)
    odometer_km   INT              NOT NULL,            -- odometer reading at the fill
    is_full_tank  BOOLEAN          NOT NULL DEFAULT TRUE,-- only full fills feed consumption math
    lat           DOUBLE PRECISION,                     -- where it was filled (optional)
    lon           DOUBLE PRECISION,
    filled_at     DATE             NOT NULL DEFAULT CURRENT_DATE,
    created_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fuel_logs_moto ON fuel_logs(motorcycle_id, odometer_km);
