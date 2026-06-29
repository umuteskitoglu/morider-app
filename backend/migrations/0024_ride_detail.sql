-- Ride detail: editable title/notes and the motorcycle the ride was made with.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS motorcycle_id BIGINT REFERENCES motorcycles(id) ON DELETE SET NULL;
