// Live "active riders" presence layer, backed by internal/telemetry/presence.go.
// Riders who opt in heartbeat their position while the map is open; nearby()
// returns everyone sharing within a radius. Returned coordinates are already
// coarsened server-side (~500 m) for privacy.

import { api } from '../api/client';

export type NearbyRider = {
  user_id: number;
  name: string;
  avatar_url: string;
  lat: number;
  lon: number;
  heading: number;
  updated_at: string;
};

// heartbeat records our position. Returns whether the server considers us active
// (false when location sharing is turned off — the caller can then stop polling).
export async function heartbeat(lat: number, lon: number, heading?: number, speed?: number): Promise<boolean> {
  try {
    const { data } = await api.post('/api/presence/heartbeat', {
      lat,
      lon,
      heading: heading ?? 0,
      speed: speed ?? 0,
    });
    return !!data?.active;
  } catch {
    return false;
  }
}

// goOffline removes our presence row so we vanish from others' maps at once.
export async function goOffline(): Promise<void> {
  try {
    await api.post('/api/presence/offline');
  } catch {
    // best effort — a stale row expires on its own within ~90s
  }
}

export async function fetchNearby(lat: number, lon: number, radius = 25000): Promise<NearbyRider[]> {
  try {
    const { data } = await api.get('/api/presence/nearby', { params: { lat, lon, radius } });
    return data?.riders ?? [];
  } catch {
    return [];
  }
}
