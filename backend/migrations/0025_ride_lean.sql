-- Ride lean summary: peak right/left lean angle (degrees) captured during the
-- ride. Null when the ride was recorded before lean tracking existed.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS max_lean_right DOUBLE PRECISION;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS max_lean_left DOUBLE PRECISION;
