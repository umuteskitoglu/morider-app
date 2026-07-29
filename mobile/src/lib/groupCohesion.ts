// Detecting when a rider comes off the back of the group.
//
// Group riding has exactly one recurring failure: the group splits and nobody
// notices. A red light cuts it in half, someone takes the wrong exit, someone
// gets a puncture — and the front carries on for twenty kilometres before
// anyone looks in a mirror. Every position needed to catch this was already
// flowing through the session socket; nothing was done with it but draw dots.
//
// Deliberately pure: no state, no timers, no I/O. The screen owns the previous
// tick and hands it back in, which makes the whole state machine reviewable by
// reading it — worth a lot for logic that is awkward to exercise on a bike.

export type RiderCohesion = 'together' | 'drifting' | 'dropped';

export type CohesionRider = {
  userId: number;
  name: string;
  lat: number;
  lon: number;
  /** Only riders reporting fresh positions take part; see markerAge. */
  fresh: boolean;
};

export type CohesionEntry = {
  userId: number;
  name: string;
  gapKm: number;
  state: RiderCohesion;
};

export type CohesionResult = {
  /** Robust centre of the group, or null when too few riders are reporting. */
  centre: { lat: number; lon: number } | null;
  entries: CohesionEntry[];
  /** Feed back into the next call. */
  gapKm: Record<number, number>;
  state: Record<number, RiderCohesion>;
  /** Riders currently off the back, worst first. */
  dropped: CohesionEntry[];
  /** How many riders reported a fresh position this tick. */
  liveCount: number;
};

// A group naturally strings out over a few hundred metres in traffic, so the
// alert threshold sits well clear of that. Rejoining is declared earlier than
// dropping, so a rider hovering at the boundary doesn't flap.
const DROP_KM = 1.0;
const REJOIN_KM = 0.6;
// Two riders still count. The median of two points is their midpoint, so both
// come out equally far from it and both get flagged — which is the truth: the
// pair is 2 km apart and neither is "the one who fell behind". The UI uses
// `liveCount` to word that case as a gap rather than as a blame.
const MIN_RIDERS_FOR_CENTRE = 2;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Median rather than mean: the whole point is to find the rider who is far
 * away, and an average would let that rider drag the "centre" toward
 * themselves, shrinking the very gap we are trying to measure.
 */
export function groupCentre(riders: CohesionRider[]): { lat: number; lon: number } | null {
  const live = riders.filter((r) => r.fresh);
  if (live.length < MIN_RIDERS_FOR_CENTRE) return null;
  return { lat: median(live.map((r) => r.lat)), lon: median(live.map((r) => r.lon)) };
}

export function evaluateCohesion(
  riders: CohesionRider[],
  prevGapKm: Record<number, number>,
  prevState: Record<number, RiderCohesion>,
): CohesionResult {
  const centre = groupCentre(riders);
  const liveCount = riders.filter((r) => r.fresh).length;
  const gapKm: Record<number, number> = {};
  const state: Record<number, RiderCohesion> = {};
  const entries: CohesionEntry[] = [];

  if (!centre) {
    // Too few reporters to judge. Everyone counts as together rather than
    // guessing — a false "you've been dropped" is worse than silence.
    for (const r of riders) state[r.userId] = 'together';
    return { centre: null, entries: [], gapKm, state, dropped: [], liveCount };
  }

  // Distances are measured to the centre, so for a pair — whose centre is the
  // midpoint — each rider's gap is only half their actual separation. Halving
  // the threshold makes "1 km apart" mean the same thing whether there are two
  // of you or ten.
  const dropAt = liveCount === 2 ? DROP_KM / 2 : DROP_KM;
  const rejoinAt = liveCount === 2 ? REJOIN_KM / 2 : REJOIN_KM;

  for (const r of riders) {
    if (!r.fresh) {
      // No fresh position is a connectivity problem, not a cohesion one. The
      // map already greys these riders out; claiming they were dropped would
      // send the group looking for someone who is riding right beside them.
      state[r.userId] = prevState[r.userId] ?? 'together';
      continue;
    }

    const gap = haversineKm({ lat: r.lat, lon: r.lon }, centre);
    const prev = prevState[r.userId] ?? 'together';
    const prevGap = prevGapKm[r.userId];

    let next: RiderCohesion;
    if (gap >= dropAt) {
      if (prev === 'dropped') next = 'dropped';
      // Confirmed only once the gap is *still growing*: a rider who is far but
      // closing is on their way back, and does not need an alarm raised.
      else if (prev === 'drifting') next = prevGap != null && gap > prevGap ? 'dropped' : 'drifting';
      else next = 'drifting';
    } else if (gap <= rejoinAt) {
      next = 'together';
    } else {
      next = prev === 'dropped' ? 'dropped' : 'together';
    }

    gapKm[r.userId] = gap;
    state[r.userId] = next;
    entries.push({ userId: r.userId, name: r.name, gapKm: gap, state: next });
  }

  const dropped = entries.filter((e) => e.state === 'dropped').sort((a, b) => b.gapKm - a.gapKm);
  return { centre, entries, gapKm, state, dropped, liveCount };
}

/** "1,2 km" / "800 m" — Turkish decimal comma, matching the rest of the app. */
export function fmtGap(km: number): string {
  return km >= 1 ? `${km.toFixed(1).replace('.', ',')} km` : `${Math.round(km * 1000)} m`;
}
