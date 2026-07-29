// Track simplification (Ramer–Douglas–Peucker).
//
// A recorded ride is one GPS fix per second: a six-hour day is ~20k points.
// That is the right resolution for telemetry and the wrong one for a saved
// route — it bloats the request, the stored geometry and every later render,
// while adding nothing a rider can see. The shape of a road survives at a few
// hundred points.

export type LatLon = { lat: number; lon: number };

// Perpendicular distance from p to the segment a–b, in metres.
//
// Latitude/longitude are treated as a local plane with longitude scaled by
// cos(lat). Over the few kilometres a single segment spans, the error is far
// below the GPS noise we're filtering anyway.
function perpendicularM(p: LatLon, a: LatLon, b: LatLon): number {
  const M_PER_DEG = 111_320;
  const latRad = (a.lat * Math.PI) / 180;
  const kx = Math.cos(latRad) * M_PER_DEG;

  const px = (p.lon - a.lon) * kx;
  const py = (p.lat - a.lat) * M_PER_DEG;
  const bx = (b.lon - a.lon) * kx;
  const by = (b.lat - a.lat) * M_PER_DEG;

  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);

  // Projection parameter, clamped so points beyond the segment measure to its
  // nearer end rather than to the infinite line.
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Iterative RDP — recursion would blow the stack on a 20k-point track. */
export function simplifyTrack(points: LatLon[], toleranceM: number): LatLon[] {
  if (points.length <= 2) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxDist = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularM(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxDist > toleranceM) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }

  const out: LatLon[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplifies until the track fits in `maxPoints`, loosening the tolerance until
 * it does. Starting tight keeps detail on tracks that are already short, while
 * the ceiling guarantees a bounded payload for a ride of any length.
 */
export function simplifyToBudget(points: LatLon[], maxPoints = 600): LatLon[] {
  if (points.length <= maxPoints) return points.slice();
  let tolerance = 5;
  let out = simplifyTrack(points, tolerance);
  // Doubling converges in a handful of passes even for a 1000 km track.
  while (out.length > maxPoints && tolerance < 2000) {
    tolerance *= 2;
    out = simplifyTrack(points, tolerance);
  }
  return out;
}
