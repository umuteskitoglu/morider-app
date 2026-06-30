-- Reward rarity + XP. Each badge has a tier (bronze/silver/gold/platinum) and an
-- XP value derived from that tier. XP drives rider level and the seasonal
-- leaderboard. Backfill existing rows from the known badge->tier mapping (kept in
-- sync with internal/reward/rules.go); challenge_* completions count as gold.
ALTER TABLE rewards ADD COLUMN IF NOT EXISTS tier TEXT;
ALTER TABLE rewards ADD COLUMN IF NOT EXISTS xp   INT NOT NULL DEFAULT 0;

UPDATE rewards SET tier = CASE
    WHEN type IN ('first_ride','century_ride','week_300','month_1000','streak_7','speedster_100','group_first','pack_5','segment_first') THEN 'bronze'
    WHEN type IN ('rider_10','long_hauler','club_1000','week_700','month_3000','streak_30','speedster_140','group_5','pack_10','segment_10') THEN 'silver'
    WHEN type IN ('rider_50','club_10000','group_20') THEN 'gold'
    WHEN type LIKE 'challenge_%' THEN 'gold'
    ELSE 'special'
END
WHERE tier IS NULL;

UPDATE rewards SET xp = CASE tier
    WHEN 'bronze' THEN 10
    WHEN 'silver' THEN 25
    WHEN 'gold' THEN 50
    WHEN 'platinum' THEN 100
    ELSE 0
END
WHERE xp = 0;
