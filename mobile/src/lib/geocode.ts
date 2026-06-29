// Forward geocoding (address text → coordinates) for the in-app place search.
// Thin client over the backend Nominatim proxy (GET /api/routes/geocode); see
// docs/routing.md. Errors are swallowed so a failed lookup just yields no
// suggestions rather than crashing the picker.
import { api } from '../api/client';

export type Place = { name: string; lat: number; lon: number };

/**
 * Searches places for the query, optionally biased toward `near` (the rider's
 * position) so nearby matches rank first. Returns [] for short/empty queries or
 * on any error.
 */
export async function searchPlaces(query: string, near?: { lat: number; lon: number }): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const params: Record<string, string | number> = { q };
    if (near) {
      params.lat = near.lat;
      params.lon = near.lon;
    }
    const { data } = await api.get('/api/routes/geocode', { params });
    return (data.places ?? []) as Place[];
  } catch {
    return [];
  }
}
