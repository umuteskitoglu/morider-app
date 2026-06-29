// Turn-by-turn navigation helpers. Steps come from the routing engine via
// POST /api/routes/plan (each step carries the maneuver point + OSRM
// type/modifier); these helpers track which step is next, format distances,
// pick arrow icons and speak instructions (Turkish TTS via expo-speech).
import * as Speech from 'expo-speech';

import { api } from '../api/client';

export type NavStep = {
  instruction: string;
  name: string;
  distance: number; // meters, length of the step
  lat: number;
  lon: number;
  type: string; // OSRM maneuver type (turn, depart, arrive, roundabout...)
  modifier: string; // left, right, slight left...
};

export type LatLon = { lat: number; lon: number };

// Reaching this close to a maneuver point advances to the next step.
const ARRIVE_RADIUS_M = 30;

// Distance in meters between two coordinates (equirectangular is plenty for
// step tracking at city scale and cheaper than full haversine per GPS tick).
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Evenly samples at most `max` waypoints, always keeping both endpoints, so a
// stored geometry can be re-planned through OSRM without hitting URL limits.
export function sampleWaypoints(points: LatLon[], max = 25): LatLon[] {
  const n = points.length;
  if (n <= max) return points;
  const out: LatLon[] = [];
  const step = (n - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out[out.length - 1] = points[n - 1];
  return out;
}

/**
 * Fetches turn-by-turn steps for a stored/loaded route geometry by re-planning
 * it through the routing engine. Works for any route the rider can see
 * (including imported GPX and group-ride routes) because it only needs the
 * points, not route ownership.
 */
export async function fetchRouteSteps(points: LatLon[]): Promise<NavStep[]> {
  if (points.length < 2) return [];
  const { data } = await api.post('/api/routes/plan', { waypoints: sampleWaypoints(points) });
  const steps: NavStep[] = (data.steps ?? []).filter(
    (s: NavStep) => s.lat !== 0 || s.lon !== 0,
  );
  return steps;
}

/**
 * Given the current position, returns the index of the next pending maneuver.
 * Sequential with two advance rules: we arrived at the step point, or we are
 * clearly closer to the following step (passed the turn between GPS ticks).
 */
export function advanceStep(steps: NavStep[], pos: LatLon, idx: number): number {
  let i = idx;
  while (i < steps.length) {
    const d = distanceM(pos, steps[i]);
    if (d < ARRIVE_RADIUS_M) {
      i += 1;
      continue;
    }
    if (i + 1 < steps.length && distanceM(pos, steps[i + 1]) + 20 < d) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

// "350 m" / "1,2 km" (Turkish decimal comma).
export function formatDistanceM(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

// MaterialCommunityIcons arrow for an OSRM maneuver.
export function stepIcon(type: string, modifier: string): string {
  if (type === 'arrive') return 'flag-checkered';
  if (type === 'depart') return 'ray-start-arrow';
  if (type === 'roundabout' || type === 'rotary') return 'rotate-right';
  if (type === 'merge') return 'call-merge';
  switch (modifier) {
    case 'left':
      return 'arrow-left-top';
    case 'right':
      return 'arrow-right-top';
    case 'slight left':
      return 'arrow-top-left';
    case 'slight right':
      return 'arrow-top-right';
    case 'sharp left':
      return 'arrow-u-left-top';
    case 'sharp right':
      return 'arrow-u-right-top';
    case 'uturn':
      return 'arrow-u-down-left';
    default:
      return 'arrow-up';
  }
}

// Spoken-instruction thresholds (meters before the maneuver).
const FAR_ANNOUNCE_M = 250;
const NEAR_ANNOUNCE_M = 50;

export type SpokenState = { idx: number; far: boolean; near: boolean };

/**
 * Speaks the upcoming instruction at ~250 m ("250 metre sonra sağa dön") and
 * again right before it (~50 m). `state` is mutated to remember what was
 * already announced; pass the same object on every GPS tick.
 */
export function maybeSpeak(state: SpokenState, idx: number, step: NavStep, distM: number, enabled: boolean): void {
  if (state.idx !== idx) {
    state.idx = idx;
    state.far = false;
    state.near = false;
  }
  if (!enabled) return;
  // Strip the road name dash for a more natural spoken sentence.
  const said = step.instruction.replace(' - ', ', ');
  if (!state.near && distM <= NEAR_ANNOUNCE_M) {
    state.near = true;
    state.far = true;
    Speech.speak(said, { language: 'tr-TR' });
    return;
  }
  if (!state.far && distM <= FAR_ANNOUNCE_M && distM > NEAR_ANNOUNCE_M) {
    state.far = true;
    Speech.speak(`${Math.round(distM / 50) * 50} metre sonra ${said}`, { language: 'tr-TR' });
  }
}

export function stopSpeaking(): void {
  Speech.stop();
}

// ---------------------------------------------------------------------------
// Re-route: when the rider strays from the route, plan a fresh path from the
// current position that rejoins the original route a little further ahead.
// ---------------------------------------------------------------------------

// Farther than this from every route vertex counts as "off route".
const OFF_ROUTE_M = 100;
// Don't re-route again within this window (GPS settles, OSRM load stays sane).
const REROUTE_COOLDOWN_MS = 20_000;
// Rejoin the route this far ahead of where it was left, so the plan doesn't
// send the rider back to the exact point they (maybe deliberately) skipped.
const REJOIN_SKIP_M = 150;
// Consecutive off-route ticks required (filters one-off GPS jumps).
const OFF_TICKS = 2;

export type RerouteState = { offCount: number; lastAt: number; inFlight: boolean };

export function newRerouteState(): RerouteState {
  return { offCount: 0, lastAt: 0, inFlight: false };
}

// Min distance from pos to the route's vertices. OSRM geometries are dense
// (vertices every few tens of meters), so vertex distance ≈ polyline distance.
export function distanceToRouteM(routePoints: LatLon[], pos: LatLon): number {
  let min = Infinity;
  for (const p of routePoints) {
    const d = distanceM(pos, p);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Feed every GPS tick; returns true when a re-route should fire (sustained
 * deviation, no request in flight, cooldown elapsed). Mutates `state`.
 */
export function offRouteTick(state: RerouteState, routePoints: LatLon[], pos: LatLon): boolean {
  if (state.inFlight || routePoints.length < 2) return false;
  if (distanceToRouteM(routePoints, pos) > OFF_ROUTE_M) {
    state.offCount += 1;
  } else {
    state.offCount = 0;
  }
  return state.offCount >= OFF_TICKS && Date.now() - state.lastAt > REROUTE_COOLDOWN_MS;
}

/**
 * Initial plan when a ride starts on a followed route. If the rider is already
 * near the route it plans the route as-is. If they begin somewhere else, their
 * current position is prepended as the first waypoint so the guide leads them
 * onto the route from wherever they actually are (instead of pointing at the
 * route's original start). Returns steps + geometry for the dashed guide line.
 */
// Result of a route plan: turn-by-turn steps, the road geometry (for the guide
// line) and the total distance (km) / duration (min) for the ETA summary.
export type PlanResult = { steps: NavStep[]; points: LatLon[]; distance: number; duration: number };

export async function planInitialRoute(routePoints: LatLon[], pos: LatLon): Promise<PlanResult> {
  if (routePoints.length < 2) return { steps: [], points: [], distance: 0, duration: 0 };
  const onRoute = distanceToRouteM(routePoints, pos) <= OFF_ROUTE_M;
  const waypoints = onRoute
    ? sampleWaypoints(routePoints)
    : [pos, ...sampleWaypoints(routePoints, 24)];
  const { data } = await api.post('/api/routes/plan', { waypoints });
  const steps: NavStep[] = (data.steps ?? []).filter((s: NavStep) => s.lat !== 0 || s.lon !== 0);
  const points: LatLon[] = data.points ?? [];
  return { steps, points, distance: data.distance ?? 0, duration: data.duration ?? 0 };
}

/**
 * Plans a fresh route from the current position that rejoins the original
 * route ~150 m ahead of the nearest point and follows it to the end. Returns
 * the new steps plus the new geometry (for redrawing the guide line).
 */
export async function rerouteFromPosition(routePoints: LatLon[], pos: LatLon): Promise<PlanResult> {
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < routePoints.length; i++) {
    const d = distanceM(pos, routePoints[i]);
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  let skip = nearest;
  let acc = 0;
  while (skip < routePoints.length - 1 && acc < REJOIN_SKIP_M) {
    acc += distanceM(routePoints[skip], routePoints[skip + 1]);
    skip += 1;
  }
  const rest = routePoints.slice(Math.min(skip, routePoints.length - 1));
  const waypoints = [pos, ...sampleWaypoints(rest, 24)];
  const { data } = await api.post('/api/routes/plan', { waypoints });
  const steps: NavStep[] = (data.steps ?? []).filter((s: NavStep) => s.lat !== 0 || s.lon !== 0);
  const points: LatLon[] = data.points ?? [];
  return { steps, points, distance: data.distance ?? 0, duration: data.duration ?? 0 };
}

export function speakRerouted(enabled: boolean): void {
  if (enabled) Speech.speak('Rota yeniden hesaplandı', { language: 'tr-TR' });
}
