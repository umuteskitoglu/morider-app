// Durable storage for recorded rides.
//
// A recorded ride is the most valuable thing this app holds, and it used to
// live only in memory: the samples were accumulated in a ref and posted once,
// at the very end. Two ways that lost a rider's whole day:
//
//   1. The upload failed (no signal at the top of the mountain — i.e. exactly
//      where the good rides happen) and the alert said "Kaydedilemedi" while
//      the data was already gone.
//   2. The OS reclaimed the process mid-ride, or the app crashed, and nothing
//      had ever been written down.
//
// So: checkpoint the in-progress ride to disk as it records, and queue finished
// rides that could not be sent, retrying them later. Losing a ride should take
// a deleted app, not a dropped connection.
//
// Uses expo-file-system/legacy (as the route screens do) rather than
// AsyncStorage: a six-hour ride is ~20k samples / ~2 MB of JSON, which is well
// past what Android's AsyncStorage is comfortable holding.
import * as FileSystem from 'expo-file-system/legacy';

import { api } from '../api/client';
import { computeRideStats } from './rideStats';
import { kapismaSummary } from './segments';

export type StoredSample = {
  latitude: number;
  longitude: number;
  altitude: number;
  /** m/s, matching the telemetry wire format. */
  speed: number;
  ts: string;
};

/** Everything needed to POST a ride, independent of any screen state. */
export type RideDraft = {
  /** Local id; also the queue filename. */
  id: string;
  distance: number;
  startTime: string;
  endTime?: string;
  elevationGain: number;
  maxLeanRight: number;
  maxLeanLeft: number;
  maxSpeed: number;
  samples: StoredSample[];
};

const ROOT = FileSystem.documentDirectory + 'morider/';
const ACTIVE = ROOT + 'active-ride.json';
const PENDING_DIR = ROOT + 'pending/';

// Rewriting the whole track is cheap enough at these sizes, and far simpler
// than an append log; once a minute keeps the worst-case loss to one minute of
// riding without writing megabytes every GPS fix.
export const CHECKPOINT_INTERVAL_MS = 60_000;

async function ensureDirs(): Promise<void> {
  for (const dir of [ROOT, PENDING_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

export function newRideId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// In-progress checkpoint
// ---------------------------------------------------------------------------

/** Writes the ride-so-far to disk, replacing any previous checkpoint. */
export async function checkpointRide(draft: RideDraft): Promise<void> {
  try {
    await ensureDirs();
    await FileSystem.writeAsStringAsync(ACTIVE, JSON.stringify(draft));
  } catch {
    // Best effort: a failed checkpoint must never interrupt the ride itself.
  }
}

/**
 * Returns an interrupted ride left on disk, if any. A checkpoint only survives
 * when the ride never reached stopRecording — a normal stop clears it.
 */
export async function loadCheckpoint(): Promise<RideDraft | null> {
  try {
    const info = await FileSystem.getInfoAsync(ACTIVE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(ACTIVE);
    const draft = JSON.parse(raw) as RideDraft;
    // A track with one point isn't a ride; drop it rather than prompting.
    if (!draft?.samples || draft.samples.length < 2) {
      await clearCheckpoint();
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(): Promise<void> {
  try {
    await FileSystem.deleteAsync(ACTIVE, { idempotent: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Pending (recorded but not yet uploaded) rides
// ---------------------------------------------------------------------------

async function pendingFiles(): Promise<string[]> {
  try {
    await ensureDirs();
    const names = await FileSystem.readDirectoryAsync(PENDING_DIR);
    return names.filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export async function pendingCount(): Promise<number> {
  return (await pendingFiles()).length;
}

async function enqueue(draft: RideDraft): Promise<void> {
  await ensureDirs();
  await FileSystem.writeAsStringAsync(PENDING_DIR + draft.id + '.json', JSON.stringify(draft));
}

async function dequeue(id: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(PENDING_DIR + id + '.json', { idempotent: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Finalisation
// ---------------------------------------------------------------------------

/**
 * Fills in the fields derived from the track. Checkpoints leave these at zero
 * (deriving them once a minute over a 20k-point track is wasted work), so both
 * the normal stop and the crash-recovery path run the ride through here first.
 */
export function finalizeDraft(draft: RideDraft): RideDraft {
  const points = draft.samples.map((s) => ({
    lat: s.latitude,
    lon: s.longitude,
    altitude: s.altitude,
    speed: s.speed,
    ts: s.ts,
  }));
  const { ascent } = computeRideStats(points);
  let maxSpeed = 0;
  for (const s of draft.samples) if (s.speed * 3.6 > maxSpeed) maxSpeed = s.speed * 3.6;
  return {
    ...draft,
    elevationGain: ascent,
    maxSpeed: Math.max(draft.maxSpeed, maxSpeed),
    // A recovered ride ends at its last fix, not at whenever the app was
    // reopened — otherwise a ride recovered the next morning claims 14 hours.
    endTime: draft.endTime ?? draft.samples[draft.samples.length - 1]?.ts ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type UploadResult = { rideId: number; kapisma: string };

/**
 * Posts one ride and its telemetry, then matches it against public kapışmalar.
 * Throws if the ride itself could not be created — the caller decides whether
 * that means "queue it" or "give up".
 */
export async function uploadRide(draft: RideDraft): Promise<UploadResult> {
  const { data: ride } = await api.post('/api/rides', {
    distance: draft.distance,
    start_time: draft.startTime,
    end_time: draft.endTime ?? new Date().toISOString(),
    elevation_gain: Math.round(draft.elevationGain),
    max_lean_right: Math.round(draft.maxLeanRight),
    max_lean_left: Math.round(draft.maxLeanLeft),
    max_speed: Math.round(draft.maxSpeed),
  });

  await api.post('/api/telemetry', {
    points: draft.samples.map((s) => ({
      ride_id: ride.id,
      lat: s.latitude,
      lon: s.longitude,
      altitude: s.altitude,
      speed: s.speed,
      ts: s.ts,
    })),
  });

  // Best effort: a ride that saved but didn't match is still a saved ride.
  let kapisma = '';
  try {
    const { data } = await api.post(`/api/rides/${ride.id}/segments/match`);
    kapisma = kapismaSummary(data.efforts ?? []);
  } catch {
    // ignore
  }

  return { rideId: ride.id, kapisma };
}

// ---------------------------------------------------------------------------
// Hand-off to the summary screen
// ---------------------------------------------------------------------------

/** What the post-ride summary needs, kept out of navigation params. */
export type RideSummary = {
  draft: RideDraft;
  /** Whether it reached the server, or is waiting in the queue. */
  uploaded: boolean;
  rideId?: number;
  kapisma: string;
  movingMs: number;
};

// A finished ride's track is tens of thousands of points; putting that through
// navigation params would bloat every state snapshot React Navigation keeps.
// The summary screen reads it from here instead, the same way FeedScreen shares
// its cache.
let lastSummary: RideSummary | null = null;

export function setLastRideSummary(s: RideSummary | null): void {
  lastSummary = s;
}

export function getLastRideSummary(): RideSummary | null {
  return lastSummary;
}

export type SaveOutcome =
  | { status: 'uploaded'; kapisma: string }
  | { status: 'queued'; error: unknown };

/**
 * The only way a finished ride should leave a screen: try to upload it, and if
 * that fails keep it on disk so it can go out later. Never throws.
 */
export async function saveOrQueueRide(draft: RideDraft): Promise<SaveOutcome> {
  // Write it down *before* attempting the network, so a crash mid-upload still
  // leaves the ride recoverable.
  try {
    await enqueue(draft);
  } catch {
    // If we can't even write it, the upload below is the only chance left.
  }
  try {
    const { kapisma } = await uploadRide(draft);
    await dequeue(draft.id);
    await clearCheckpoint();
    return { status: 'uploaded', kapisma };
  } catch (error) {
    await clearCheckpoint(); // the ride is in the queue now, not in progress
    return { status: 'queued', error };
  }
}

/**
 * Retries every queued ride. Safe to call often (app start, ride screen focus);
 * failures stay queued for the next attempt.
 */
export async function flushPendingRides(): Promise<{ sent: number; failed: number }> {
  const files = await pendingFiles();
  let sent = 0;
  let failed = 0;
  for (const name of files) {
    try {
      const raw = await FileSystem.readAsStringAsync(PENDING_DIR + name);
      const draft = JSON.parse(raw) as RideDraft;
      await uploadRide(draft);
      await dequeue(draft.id);
      sent += 1;
    } catch {
      // Stop on the first failure: these are almost always "no network", and
      // hammering the rest just burns battery on a mountain road.
      failed = files.length - sent;
      break;
    }
  }
  return { sent, failed };
}
