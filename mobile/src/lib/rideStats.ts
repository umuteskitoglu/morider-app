// Derives ride stats, chart series and a speed-coloured path from a ride's
// telemetry track (GET /api/rides/:id/track). Speed arrives in m/s (as the
// client uploaded it); everything user-facing here is converted to km/h.
import { ElevationProfile } from '../components/ElevationChart';

export type TrackPoint = {
  lat: number;
  lon: number;
  altitude: number; // meters
  speed: number; // m/s
  ts: string; // ISO
};

export type Coord = { latitude: number; longitude: number };

// Speed below this (m/s ≈ 3.6 km/h) counts as stopped for "moving time".
const MOVING_MIN_MS = 1;
// Altitude must change by at least this (m) before it counts toward gain/loss,
// to keep GPS jitter from inflating the totals.
const ELE_NOISE_M = 3;

export type RideStats = {
  distanceKm: number;
  durationMs: number; // wall clock: last ts − first ts
  movingMs: number; // time spent above MOVING_MIN_MS
  avgSpeed: number; // km/h over moving time
  maxSpeed: number; // km/h
  ascent: number; // m
  descent: number; // m
  maxAlt: number; // m
  minAlt: number; // m
};

function haversineKm(a: TrackPoint, b: TrackPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function computeRideStats(points: TrackPoint[]): RideStats {
  const empty: RideStats = {
    distanceKm: 0,
    durationMs: 0,
    movingMs: 0,
    avgSpeed: 0,
    maxSpeed: 0,
    ascent: 0,
    descent: 0,
    maxAlt: 0,
    minAlt: 0,
  };
  if (points.length < 2) return empty;

  let distanceKm = 0;
  let movingMs = 0;
  let maxSpeedMs = 0;
  let ascent = 0;
  let descent = 0;
  let maxAlt = -Infinity;
  let minAlt = Infinity;
  let refAlt = points[0].altitude;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.speed > maxSpeedMs) maxSpeedMs = p.speed;
    if (p.altitude > maxAlt) maxAlt = p.altitude;
    if (p.altitude < minAlt) minAlt = p.altitude;
    const delta = p.altitude - refAlt;
    if (Math.abs(delta) >= ELE_NOISE_M) {
      if (delta > 0) ascent += delta;
      else descent += -delta;
      refAlt = p.altitude;
    }
    if (i > 0) {
      const prev = points[i - 1];
      distanceKm += haversineKm(prev, p);
      const dt = new Date(p.ts).getTime() - new Date(prev.ts).getTime();
      if (dt > 0 && (p.speed > MOVING_MIN_MS || prev.speed > MOVING_MIN_MS)) movingMs += dt;
    }
  }

  const durationMs = new Date(points[points.length - 1].ts).getTime() - new Date(points[0].ts).getTime();
  const movingHours = movingMs / 3_600_000;
  return {
    distanceKm,
    durationMs,
    movingMs,
    avgSpeed: movingHours > 0 ? distanceKm / movingHours : 0,
    maxSpeed: maxSpeedMs * 3.6,
    ascent,
    descent,
    maxAlt: maxAlt === -Infinity ? 0 : maxAlt,
    minAlt: minAlt === Infinity ? 0 : minAlt,
  };
}

export function toCoords(points: TrackPoint[]): Coord[] {
  return points.map((p) => ({ latitude: p.lat, longitude: p.lon }));
}

// Bounding box for fitting/region and POI bbox queries.
export function bounds(points: TrackPoint[]): { minLat: number; minLon: number; maxLat: number; maxLon: number } | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

// Speed ramp (km/h): slow→cool, fast→warm. Distinct from the dark map.
const SPEED_BANDS: { max: number; color: string; label: string }[] = [
  { max: 30, color: '#3B82F6', label: '<30' },
  { max: 60, color: '#2FD27A', label: '30–60' },
  { max: 90, color: '#F5A623', label: '60–90' },
  { max: Infinity, color: '#FF3B47', label: '90+' },
];

export const SPEED_LEGEND = SPEED_BANDS.map((b) => ({ color: b.color, label: b.label }));

export function speedColor(kmh: number): string {
  for (const b of SPEED_BANDS) if (kmh < b.max) return b.color;
  return SPEED_BANDS[SPEED_BANDS.length - 1].color;
}

// Groups the track into consecutive same-colour runs so the map can draw a few
// coloured <Polyline> pieces instead of one segment per point.
export function coloredSegments(points: TrackPoint[]): { color: string; coordinates: Coord[] }[] {
  if (points.length < 2) return [];
  const segments: { color: string; coordinates: Coord[] }[] = [];
  let current = speedColor(points[0].speed * 3.6);
  let coords: Coord[] = [{ latitude: points[0].lat, longitude: points[0].lon }];
  for (let i = 1; i < points.length; i++) {
    const color = speedColor(points[i].speed * 3.6);
    coords.push({ latitude: points[i].lat, longitude: points[i].lon });
    if (color !== current) {
      segments.push({ color: current, coordinates: coords });
      // start next run sharing this vertex so the path has no gaps
      coords = [{ latitude: points[i].lat, longitude: points[i].lon }];
      current = color;
    }
  }
  if (coords.length > 1) segments.push({ color: current, coordinates: coords });
  return segments;
}

// Downsamples an array to roughly `target` points, preserving the first/last.
function downsample<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

// Elevation profile for <ElevationChart>: cumulative km vs meters.
export function buildElevationProfile(points: TrackPoint[], stats: RideStats): ElevationProfile | null {
  if (points.length < 2) return null;
  let dist = 0;
  const raw: { dist: number; ele: number }[] = [{ dist: 0, ele: points[0].altitude }];
  for (let i = 1; i < points.length; i++) {
    dist += haversineKm(points[i - 1], points[i]);
    raw.push({ dist, ele: points[i].altitude });
  }
  return {
    points: downsample(raw, 120),
    gain: stats.ascent,
    loss: stats.descent,
    min: stats.minAlt,
    max: stats.maxAlt,
  };
}

// Speed-over-distance series (km vs km/h) for <SpeedChart>.
export function buildSpeedSeries(points: TrackPoint[]): { dist: number; speed: number }[] {
  if (points.length < 2) return [];
  let dist = 0;
  const raw: { dist: number; speed: number }[] = [{ dist: 0, speed: points[0].speed * 3.6 }];
  for (let i = 1; i < points.length; i++) {
    dist += haversineKm(points[i - 1], points[i]);
    raw.push({ dist, speed: points[i].speed * 3.6 });
  }
  return downsample(raw, 120);
}

// "1:23:45" or "12:05" for a duration in ms.
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
