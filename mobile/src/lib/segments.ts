// Segment types + helpers, matching the backend (internal/ride/segments.go).

export type SegPoint = { lat: number; lon: number };

export type Segment = {
  id: number;
  user_id: number;
  name: string;
  distance: number; // km
  visibility: string;
  points: SegPoint[];
  my_best_seconds: number; // 0 = no effort yet
  rider_count: number; // distinct riders with an effort here
  effort_count: number; // total efforts posted
  variant_count: number; // overlapping kapışmalar folded behind this one in Keşfet (0 = alone)
};

export type Effort = {
  segment_id: number;
  segment_name: string;
  ride_id: number;
  elapsed_seconds: number;
  avg_speed: number;
  is_pr: boolean;
  rank: number; // position on the leaderboard, 1 = fastest (0 = unknown)
  rider_count: number; // total riders with an effort on this segment
};

export type LeaderboardEntry = {
  user_id: number;
  name: string;
  elapsed_seconds: number;
  avg_speed: number;
};

// Seconds → "m:ss" or "h:mm:ss".
export function fmtSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// isNotableEffort — worth interrupting the rider for. A passive ride can match
// many segments on the same road; we only surface a new personal record or a
// podium finish (top 3), so a busy road never spams. Everything else is still
// recorded silently and visible in the ride detail.
export function isNotableEffort(e: Effort): boolean {
  return e.is_pr || (e.rank > 0 && e.rank <= 3);
}

// effortLine describes one notable effort, leading with its strongest angle:
// crown (1st) > podium (2nd/3rd) > personal record.
function effortLine(e: Effort): string {
  const pr = e.is_pr ? ' (rekor)' : '';
  if (e.rank === 1) return `👑 ${e.segment_name} — zirvedesin${pr}`;
  if (e.rank === 2) return `🥈 ${e.segment_name} — 2. oldun${pr}`;
  if (e.rank === 3) return `🥉 ${e.segment_name} — 3. oldun${pr}`;
  return `⏱ ${e.segment_name} — yeni rekor`;
}

// effortScore orders notable efforts strongest-first (lower = stronger).
function effortScore(e: Effort): number {
  if (e.rank === 1) return 0;
  if (e.rank === 2) return 1;
  if (e.rank === 3) return 2;
  return 3; // PR outside the podium
}

// kapismaSummary folds a ride's matched efforts into ONE message (never one per
// segment). Returns '' when nothing is notable, so the caller can stay silent.
export function kapismaSummary(efforts: Effort[]): string {
  const notable = efforts.filter(isNotableEffort).sort((a, b) => effortScore(a) - effortScore(b));
  if (notable.length === 0) return '';
  const header =
    notable.length === 1 ? '🏁 Bir kapışmada öne çıktın!' : `🏁 ${notable.length} kapışmada öne çıktın!`;
  // Cap the body at 3 lines so a very busy ride stays readable.
  return [header, ...notable.slice(0, 3).map(effortLine)].join('\n');
}

// Evenly thin a coordinate list to at most `max` points, keeping the endpoints.
// Used when turning a full ride track into a segment so the stored geometry
// stays compact.
export function thin<T>(points: T[], max: number): T[] {
  const n = points.length;
  if (n <= max) return points;
  const out: T[] = [];
  const step = (n - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  out[max - 1] = points[n - 1];
  return out;
}
