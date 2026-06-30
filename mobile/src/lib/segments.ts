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
};

export type Effort = {
  segment_id: number;
  segment_name: string;
  ride_id: number;
  elapsed_seconds: number;
  avg_speed: number;
  is_pr: boolean;
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
