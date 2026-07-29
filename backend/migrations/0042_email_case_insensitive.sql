-- Morider App - make email uniqueness case-insensitive
--
-- users.email was declared TEXT NOT NULL UNIQUE, which Postgres compares
-- case-sensitively. usernames, added later in 0014, correctly use a unique
-- index on lower(username) — email never got the same treatment.
--
-- The consequence: "Umut@example.com" and "umut@example.com" were two separate
-- accounts. A rider who capitalised their address differently on a later login
-- simply could not get in, signed up again, and landed in an empty account with
-- none of their rides. Password reset would have compounded it by targeting
-- whichever row it happened to match.
--
-- This migration REFUSES to run if such duplicates already exist, rather than
-- picking a winner and silently destroying the other account's data. Merging is
-- a product decision (which account survives? where do their rides go?), not
-- something a schema migration should decide.

DO $$
DECLARE
  dup_count int;
  sample    text;
BEGIN
  SELECT count(*), min(lower_email)
    INTO dup_count, sample
  FROM (
    SELECT lower(email) AS lower_email
    FROM users
    GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'refusing to add a case-insensitive email index: % address(es) differ only by case (e.g. %). '
      'These must be merged by hand first — decide which account survives and move its rides/posts '
      'across — then re-run migrations.',
      dup_count, sample;
  END IF;
END $$;

-- Safe now that collisions are ruled out: store addresses in their normalised
-- form so the column matches what the application writes from here on.
UPDATE users SET email = lower(email) WHERE email <> lower(email);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

-- The old case-sensitive constraint is now redundant and would still permit
-- nothing the new index does not already cover.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
