-- Morider App - garaj: motosikletler, belge tarihleri ve servis defteri.
-- Document expiry dates power on-device reminders (trafik sigortası, kasko,
-- muayene); service_records is the maintenance log per motorcycle.

CREATE TABLE IF NOT EXISTS motorcycles (
    id                BIGSERIAL   PRIMARY KEY,
    user_id           BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT        NOT NULL,             -- "MT-07", "Beyaz CB650R" ...
    plate             TEXT,
    year              INT,
    insurance_expiry  DATE,                             -- trafik sigortası bitiş
    kasko_expiry      DATE,                             -- kasko bitiş
    inspection_expiry DATE,                             -- muayene geçerlilik sonu
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_motorcycles_user ON motorcycles(user_id);

CREATE TABLE IF NOT EXISTS service_records (
    id            BIGSERIAL   PRIMARY KEY,
    motorcycle_id BIGINT      NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
    title         TEXT        NOT NULL,                 -- "Yağ + filtre", "Ön lastik" ...
    note          TEXT,
    odometer_km   INT,
    cost          DOUBLE PRECISION,
    service_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_records_moto ON service_records(motorcycle_id, service_date DESC);
