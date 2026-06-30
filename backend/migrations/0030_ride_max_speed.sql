-- Top speed per ride (km/h), sent by the client from the recorded track. Powers
-- "top speed" challenges cheaply (MAX over rides) without scanning telemetry.
-- Null for rides recorded before this column existed.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS max_speed DOUBLE PRECISION;
