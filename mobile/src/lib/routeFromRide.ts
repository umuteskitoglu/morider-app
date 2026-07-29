// Turning a ride into a route.
//
// The best routes a rider owns are the ones they already rode — but a recorded
// ride and a saved route lived in separate worlds, so a great day's riding
// could never be repeated, shared, or handed to a friend. This converts one
// into the other.
//
// The track is stored as-is (`snap: false`): it was recorded *on* the roads, so
// running it back through the routing engine could only move it off them.
import { api } from '../api/client';
import { simplifyToBudget } from './simplify';

export type TrackPoint = { latitude: number; longitude: number };

export type CreatedRoute = { id: number; name: string; distance: number };

/**
 * Creates a route from a ride's track. `visibility` follows the routes API:
 * private (default), friends, or public.
 */
export async function createRouteFromTrack(
  name: string,
  track: TrackPoint[],
  visibility: 'private' | 'friends' | 'public' = 'private',
): Promise<CreatedRoute> {
  const simplified = simplifyToBudget(
    track.map((p) => ({ lat: p.latitude, lon: p.longitude })),
    600,
  );
  if (simplified.length < 2) {
    throw new Error('Rota oluşturmak için yeterli konum verisi yok.');
  }
  const { data } = await api.post('/api/routes', {
    name: name.trim(),
    description: '',
    points: simplified,
    // The ride already followed the roads; snapping would only introduce drift.
    snap: false,
    visibility,
  });
  return { id: data.id, name: data.name, distance: data.distance };
}

/** "23 Temmuz Pazar sürüşü" — a default the rider will actually recognise. */
export function defaultRouteName(when: Date = new Date()): string {
  const day = when.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
  const weekday = when.toLocaleDateString('tr-TR', { weekday: 'long' });
  return `${day} ${weekday} sürüşü`;
}
