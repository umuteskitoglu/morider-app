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
  exit?: number; // roundabout exit number (1-based)
  ref?: string; // road number ("D-100") when known
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

// Distance in meters from p to the segment a–b (same equirectangular scale as
// distanceM), for Douglas-Peucker deviation checks.
function pointSegmentDistM(p: LatLon, a: LatLon, b: LatLon): number {
  const latScale = 111_320;
  const lonScale = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const px = (p.lon - a.lon) * lonScale;
  const py = (p.lat - a.lat) * latScale;
  const bx = (b.lon - a.lon) * lonScale;
  const by = (b.lat - a.lat) * latScale;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

// Douglas-Peucker: keeps only vertices deviating more than toleranceM from the
// chord between their kept neighbors (endpoints always kept).
function douglasPeucker(points: LatLon[], toleranceM: number): LatLon[] {
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop() as [number, number];
    let maxD = 0;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegmentDistM(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > toleranceM && maxI > 0) {
      keep[maxI] = true;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Picks at most `max` shape-defining corner waypoints from a geometry
 * (Douglas-Peucker). Every waypoint sent to the routing engine is a mandatory
 * via-point, and a straight-road jitter vertex snapping to a parallel street
 * can balloon the plan into a giant detour — so fewer, corner-only points are
 * strictly safer than dense even sampling. Deliberate scenic loops survive:
 * they deviate far from the chord. If corners alone still exceed `max`, the
 * tolerance is doubled (dropping the least shape-defining corners first)
 * before falling back to even sampling as the hard cap.
 */
export function simplifyWaypoints(points: LatLon[], toleranceM = 75, max = 12): LatLon[] {
  if (points.length <= 2) return points;
  let tol = toleranceM;
  let out = douglasPeucker(points, tol);
  for (let i = 0; i < 4 && out.length > max; i++) {
    tol *= 2;
    out = douglasPeucker(points, tol);
  }
  return sampleWaypoints(out, max);
}

// Length of a polyline in km.
export function pathLengthKm(points: LatLon[]): number {
  let m = 0;
  for (let i = 0; i + 1 < points.length; i++) m += distanceM(points[i], points[i + 1]);
  return m / 1000;
}

/**
 * Fetches turn-by-turn steps for a stored/loaded route geometry by re-planning
 * it through the routing engine. Works for any route the rider can see
 * (including imported GPX and group-ride routes) because it only needs the
 * points, not route ownership.
 */
export async function fetchRouteSteps(points: LatLon[]): Promise<NavStep[]> {
  if (points.length < 2) return [];
  const { data } = await api.post('/api/routes/plan', { waypoints: simplifyWaypoints(points) });
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
  if (type.includes('roundabout') || type.includes('rotary')) return 'rotate-right';
  if (type === 'merge') return 'call-merge';
  // A straight fork has no direction arrow; sided forks/ramps fall through to
  // the modifier arrows below, which already read naturally for them.
  if (type === 'fork' && (modifier === '' || modifier === 'straight')) return 'call-split';
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

// Index of the route vertex nearest to pos (and its distance in meters).
export function nearestVertex(routePoints: LatLon[], pos: LatLon): { index: number; dist: number } {
  let index = 0;
  let dist = Infinity;
  for (let i = 0; i < routePoints.length; i++) {
    const d = distanceM(pos, routePoints[i]);
    if (d < dist) {
      dist = d;
      index = i;
    }
  }
  return { index, dist };
}

// Min distance from pos to the route's vertices. OSRM geometries are dense
// (vertices every few tens of meters), so vertex distance ≈ polyline distance.
export function distanceToRouteM(routePoints: LatLon[], pos: LatLon): number {
  return nearestVertex(routePoints, pos).dist;
}

/**
 * Nearest route vertex at or ahead of the rider's known progress. A global
 * nearest search misbehaves on self-approaching geometry (figure-8s, out-and-
 * back roads): it can match a much later — or earlier — pass and make the
 * remaining distance jump wildly. Searching only from `fromIdx` (minus a small
 * slack for GPS jitter) keeps progress monotonic; among near-tied vertices the
 * earliest index wins so a crossing never teleports progress forward.
 */
export function nearestVertexAhead(
  points: LatLon[],
  pos: LatLon,
  fromIdx: number,
  backSlack = 25,
): { index: number; dist: number } {
  const start = Math.max(0, Math.min(fromIdx, points.length - 1) - backSlack);
  let best = Infinity;
  for (let i = start; i < points.length; i++) {
    const d = distanceM(pos, points[i]);
    if (d < best) best = d;
  }
  for (let i = start; i < points.length; i++) {
    if (distanceM(pos, points[i]) <= best + 20) return { index: i, dist: best };
  }
  return { index: start, dist: best };
}

// Distance (km) still to ride: from pos to the vertex at idx, then along the
// remaining geometry to the end.
export function remainingKmFrom(points: LatLon[], idx: number, pos: LatLon): number {
  if (points.length < 2) return 0;
  const i0 = Math.max(0, Math.min(idx, points.length - 1));
  let m = distanceM(pos, points[i0]);
  for (let i = i0; i < points.length - 1; i++) m += distanceM(points[i], points[i + 1]);
  return m / 1000;
}

/**
 * Whether a saved A→B route makes more sense ridden in reverse (B→A) from
 * where the rider currently stands: true when the end is clearly closer than
 * the start. The 100 m margin keeps loops (start ≈ end) and genuinely
 * ambiguous positions on the recorded direction.
 */
export function shouldReverseRoute(routePoints: LatLon[], pos: LatLon): boolean {
  if (routePoints.length < 2) return false;
  const toStart = distanceM(pos, routePoints[0]);
  const toEnd = distanceM(pos, routePoints[routePoints.length - 1]);
  return toEnd + 100 < toStart;
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
 * Initial plan when a ride starts on a followed route.
 *
 * - Rider already on the route → plan only the *remaining* part, from the
 *   vertex nearest to them to the end. Planning the whole stored geometry
 *   (the old behavior) made the first instruction point back toward the
 *   route's original start whenever the rider stood anywhere but exactly
 *   there — the main source of "navigation is telling me to go backwards".
 * - Rider somewhere else → prepend their position so the guide leads them
 *   onto the route instead of assuming they teleport to its start.
 *
 * Returns steps + geometry for the guide line.
 */
// Result of a route plan: turn-by-turn steps, the road geometry (for the guide
// line) and the total distance (km) / duration (min) for the ETA summary.
export type PlanResult = { steps: NavStep[]; points: LatLon[]; distance: number; duration: number };

// A plan is sane when it doesn't wildly exceed the length of the geometry it
// is supposed to follow. The factor absorbs legitimate detours (one-way
// systems, river crossings); the absolute slack keeps short remainders from
// false-positiving (2 km left but a forced 8 km motorway-junction loop).
const PLAN_SANITY_FACTOR = 1.5;
const PLAN_SANITY_SLACK_KM = 10;
// Retry ladder: total waypoint counts to try. Fewer via-points means fewer
// chances for a bad road snap; the last rung is just [pos, endpoint].
const VIA_LADDER = [12, 6, 2];
// Only geometries at least this dense get a sanity expectation — for sparse
// inputs (a 2-point destination search) the straight-line length is not a
// meaningful bound on road distance.
const MIN_DENSE_GEOMETRY = 10;

export function isPlanSane(plannedKm: number, expectedKm: number): boolean {
  return plannedKm <= Math.max(expectedKm * PLAN_SANITY_FACTOR, expectedKm + PLAN_SANITY_SLACK_KM);
}

/**
 * Plans pos → along `rest` to its end, guarding against ballooned results.
 * Every waypoint is a mandatory via-point for the engine, and one vertex
 * snapping to the wrong road (opposite carriageway, parallel street) can turn
 * a 19 km route into a 200 km detour tour — so each plan is checked against
 * the expected distance and retried with progressively fewer via-points.
 * Throws when no rung produces a sane plan; callers keep their previous
 * steps/guide in that case.
 */
async function planSanely(pos: LatLon, rest: LatLon[], expectedKm: number | null): Promise<PlanResult> {
  let lastErr: unknown = new Error('rota planlanamadı');
  for (const rung of VIA_LADDER) {
    const vias = rung <= 2 ? [rest[rest.length - 1]] : simplifyWaypoints(rest, 75, rung - 1);
    try {
      const { data } = await api.post('/api/routes/plan', { waypoints: [pos, ...vias] });
      const distance: number = data.distance ?? 0;
      if (expectedKm !== null && !isPlanSane(distance, expectedKm)) {
        lastErr = new Error(`plan ${distance.toFixed(1)} km, beklenen ~${expectedKm.toFixed(1)} km`);
        continue;
      }
      const steps: NavStep[] = (data.steps ?? []).filter((s: NavStep) => s.lat !== 0 || s.lon !== 0);
      const points: LatLon[] = data.points ?? [];
      return { steps, points, distance, duration: data.duration ?? 0 };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function planInitialRoute(routePoints: LatLon[], pos: LatLon): Promise<PlanResult> {
  if (routePoints.length < 2) return { steps: [], points: [], distance: 0, duration: 0 };
  const { index, dist } = nearestVertex(routePoints, pos);
  // Rider already on the route → plan only the remaining part; keep at least
  // the final leg so someone standing at the very end still gets a valid plan.
  const rest =
    dist <= OFF_ROUTE_M ? routePoints.slice(Math.min(index, routePoints.length - 2)) : routePoints;
  const expectedKm =
    rest.length >= MIN_DENSE_GEOMETRY ? pathLengthKm(rest) + distanceM(pos, rest[0]) / 1000 : null;
  return planSanely(pos, rest, expectedKm);
}

/**
 * Plans a fresh route from the current position that rejoins the original
 * route ~150 m ahead of the nearest point and follows it to the end. Returns
 * the new steps plus the new geometry (for redrawing the guide line).
 */
export async function rerouteFromPosition(routePoints: LatLon[], pos: LatLon): Promise<PlanResult> {
  const { index: nearest } = nearestVertex(routePoints, pos);
  let skip = nearest;
  let acc = 0;
  while (skip < routePoints.length - 1 && acc < REJOIN_SKIP_M) {
    acc += distanceM(routePoints[skip], routePoints[skip + 1]);
    skip += 1;
  }
  const rest = routePoints.slice(Math.min(skip, routePoints.length - 1));
  const expectedKm =
    rest.length >= MIN_DENSE_GEOMETRY ? pathLengthKm(rest) + distanceM(pos, rest[0]) / 1000 : null;
  return planSanely(pos, rest, expectedKm);
}

export function speakRerouted(enabled: boolean): void {
  if (enabled) Speech.speak('Rota yeniden hesaplandı', { language: 'tr-TR' });
}
