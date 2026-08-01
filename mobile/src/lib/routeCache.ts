// Offline copies of saved routes.
//
// This is the gap that actually strands a rider. You plan a route at home on
// wifi, ride out to where the good roads are, and that is exactly where the
// bars disappear — so the route screen, which fetched everything on focus,
// showed an empty map, and starting the ride from it was impossible. The data
// was never the problem: a route's geometry hasn't changed since you saved it.
//
// So every route the rider opens is written to disk, and both the detail screen
// and the map's follow-route mode fall back to that copy when the network is
// gone. What still needs signal is turn-by-turn: the maneuver list comes from
// the routing engine and depends on where the rider is standing right now
// (lib/navigation), so offline you get the line, the distance and the
// off-route warning, but not spoken instructions.
//
// Files, not AsyncStorage: a planned route runs to thousands of points, and
// several cached routes would be megabytes — the same reason lib/rideStore
// keeps tracks on disk.
import * as FileSystem from 'expo-file-system/legacy';

import type { ElevationProfile } from '../components/ElevationChart';
import type { POI } from './poi';

export type RoutePoint = { lat: number; lon: number };

/** A route detail screen's whole payload, as last seen from the server. */
export type CachedRoute = {
  id: number;
  name: string;
  description: string;
  distance: number;
  user_id: number | null;
  owner_name: string;
  visibility: string;
  avg_rating: number;
  rating_count: number;
  my_rating: number;
  points: RoutePoint[];
  pois: POI[];
  elevation: ElevationProfile | null;
  /** When this copy was taken. */
  savedAt: number;
};

const DIR = FileSystem.documentDirectory + 'morider/routes/';

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

function fileFor(id: number): string {
  return `${DIR}${id}.json`;
}

export async function saveCachedRoute(route: Omit<CachedRoute, 'savedAt'>): Promise<void> {
  try {
    await ensureDir();
    const payload: CachedRoute = { ...route, savedAt: Date.now() };
    await FileSystem.writeAsStringAsync(fileFor(route.id), JSON.stringify(payload));
  } catch {
    // Best effort — the screen already has the data it needs from the network.
  }
}

export async function loadCachedRoute(id: number): Promise<CachedRoute | null> {
  try {
    const info = await FileSystem.getInfoAsync(fileFor(id));
    if (!info.exists) return null;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(fileFor(id))) as CachedRoute;
    // A route without a line is no use offline; treat it as a miss.
    if (!parsed?.points || parsed.points.length < 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Ids of every route available offline, so the list screen can mark them —
 * with no signal, knowing which route you can still open matters more than
 * seeing all their names.
 */
export async function cachedRouteIds(): Promise<Set<number>> {
  try {
    await ensureDir();
    const names = await FileSystem.readDirectoryAsync(DIR);
    const ids = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => Number(n.slice(0, -5)))
      .filter((n) => Number.isFinite(n));
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export async function removeCachedRoute(id: number): Promise<void> {
  try {
    await FileSystem.deleteAsync(fileFor(id), { idempotent: true });
  } catch {
    // ignore
  }
}

/** Wipes every offline route — see clearOfflineData in lib/offlineCache. */
export async function clearCachedRoutes(): Promise<void> {
  try {
    await FileSystem.deleteAsync(DIR, { idempotent: true });
  } catch {
    // ignore
  }
}
