// Raising an emergency alert.
//
// The old path was: open the SMS composer, and hope someone taps send. That
// only works if the rider is conscious and holding the phone — the one case
// where they don't need an automatic crash detector. Everything here is built
// around the opposite assumption.
//
// The alert now goes to the server, which records it and pushes it to the
// rider's group (including phones with the app backgrounded, which the session
// WebSocket never reached). If there's no signal, it is queued and retried:
// crashes happen in dead zones, and a rider who regains a bar of signal twenty
// minutes later should still summon help.
//
// The SMS composer is kept as a *last* step, not the mechanism — it's the only
// way to reach someone who isn't a Morider user, but it can never be the plan.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { api } from '../api/client';

const QUEUE_KEY = 'morider.sosQueue';

export type SosPayload = {
  /** Stable per incident: the server collapses retries onto one alert. */
  client_id: string;
  session_code?: string;
  lat?: number;
  lon?: number;
  accuracy_m?: number;
  battery_pct?: number;
  source: 'crash' | 'manual';
  /** When the incident happened, for the queue's own bookkeeping. */
  raised_at: string;
};

export type SosResult =
  | { status: 'sent'; sosId: number; notified: number }
  | { status: 'queued' };

export function newSosId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<SosPayload[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as SosPayload[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(items: SosPayload[]): Promise<void> {
  try {
    if (items.length === 0) await AsyncStorage.removeItem(QUEUE_KEY);
    else await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

/**
 * Sends an SOS, queueing it if the network is unavailable. Never throws: the
 * caller is in the middle of an emergency and has nothing useful to do with an
 * exception.
 */
export async function raiseSOS(payload: SosPayload): Promise<SosResult> {
  try {
    const { data } = await api.post('/api/sos', payload);
    return { status: 'sent', sosId: data.sos_id, notified: data.notified ?? 0 };
  } catch {
    const q = await readQueue();
    // Same incident twice (e.g. the screen retried) stays one entry.
    if (!q.some((p) => p.client_id === payload.client_id)) {
      q.push(payload);
      await writeQueue(q);
    }
    return { status: 'queued' };
  }
}

/**
 * Retries queued alerts. Called on app start and whenever a ride screen comes
 * into focus, so regaining signal is enough to get the alert out.
 *
 * Alerts older than a day are dropped: at that point the incident is long over
 * and a delayed "he may have crashed" push is alarming rather than useful.
 */
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;

export async function flushSOSQueue(): Promise<number> {
  const q = await readQueue();
  if (q.length === 0) return 0;

  const fresh = q.filter((p) => Date.now() - new Date(p.raised_at).getTime() < MAX_QUEUE_AGE_MS);
  const remaining: SosPayload[] = [];
  let sent = 0;
  for (const payload of fresh) {
    try {
      await api.post('/api/sos', payload);
      sent += 1;
    } catch {
      remaining.push(payload);
    }
  }
  await writeQueue(remaining);
  return sent;
}

/** Marks an alert as over. Best effort — a false alarm left open is harmless. */
export async function resolveSOS(sosId: number): Promise<void> {
  try {
    await api.post(`/api/sos/${sosId}/resolve`);
  } catch {
    // ignore
  }
}
