-- Morider App - link a planned event to its live group ride.
-- When the host starts the ride from an event, a ride_sessions row is created and
-- referenced here so attendees (RSVP "going") can join the same live session.
-- ON DELETE SET NULL keeps the event around if the session row is ever removed.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS ride_session_id BIGINT REFERENCES ride_sessions(id) ON DELETE SET NULL;
