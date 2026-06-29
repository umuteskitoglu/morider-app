// Background-capable GPS for an active group ride. Unlike watchPositionAsync
// (which only fires while the app is foregrounded), this uses a TaskManager
// task + a foreground service so location keeps streaming — and the JS runtime
// stays alive — when the rider locks the screen or switches apps. That in turn
// keeps the live-position WebSocket and turn-by-turn voice working in the
// background, the way Google Maps and Discord do.
//
// The task is registered at module load (imported from index.ts). While the app
// process is alive (the foreground service guarantees this during a ride) the
// task callback runs in the same JS context, so we forward fixes to the mounted
// ride screen through a single module-level handler it sets on mount.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export const RIDE_LOCATION_TASK = 'morider-ride-location';

export type RideFix = {
  lat: number;
  lon: number;
  // km/h, clamped to >= 0 (a -1 "unknown" GPS speed becomes 0).
  speed: number;
  heading: number;
  altitude: number;
  ts: string;
};

let handler: ((fix: RideFix) => void) | null = null;

// The mounted GroupRideScreen registers its location handler here; cleared on
// unmount so a stale closure never receives fixes after the screen is gone.
export function setRideLocationHandler(fn: ((fix: RideFix) => void) | null): void {
  handler = fn;
}

TaskManager.defineTask(RIDE_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const loc = locations?.[locations.length - 1];
  if (!loc || !handler) return;
  handler({
    lat: loc.coords.latitude,
    lon: loc.coords.longitude,
    speed: Math.max(0, (loc.coords.speed ?? 0) * 3.6),
    heading: loc.coords.heading ?? -1,
    altitude: loc.coords.altitude ?? 0,
    ts: new Date(loc.timestamp).toISOString(),
  });
});

// Persistent Android notification text for the location foreground service.
// Defaults describe a group ride; solo recording passes its own copy.
export type RideNotification = { notificationTitle?: string; notificationBody?: string };

// Begin streaming fixes through the foreground-service task. Safe to call when
// already started (stops the previous registration first). The persistent
// Android notification is required by the OS for a location foreground service.
export async function startRideLocation(notif?: RideNotification): Promise<void> {
  const already = await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK).catch(() => false);
  if (already) return;
  await Location.startLocationUpdatesAsync(RIDE_LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    distanceInterval: 5,
    timeInterval: 3000,
    // iOS: keep delivering while backgrounded and show the blue location bar.
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    // Android: a foreground service is mandatory for background location.
    foregroundService: {
      notificationTitle: notif?.notificationTitle ?? 'Morider grup sürüşü',
      notificationBody: notif?.notificationBody ?? 'Canlı konum paylaşımı ve sesli yönlendirme açık.',
      notificationColor: '#FF6A1A',
    },
  });
}

export async function stopRideLocation(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK).catch(() => {});
}
