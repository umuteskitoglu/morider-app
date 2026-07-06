-- Morider App - maintenance history
-- Links service records created via "mark done" to their source maintenance
-- schedule entry. Orphan records (manually added before this migration) keep
-- maintenance_schedule_id = NULL and remain visible in the legacy API but are
-- no longer surfaced in the merged maintenance+history UI.

ALTER TABLE service_records
  ADD COLUMN IF NOT EXISTS maintenance_schedule_id BIGINT
  REFERENCES maintenance_schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sr_maintenance_schedule
  ON service_records (maintenance_schedule_id)
  WHERE maintenance_schedule_id IS NOT NULL;
