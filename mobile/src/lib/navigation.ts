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
