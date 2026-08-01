// Read-side offline cache.
//
// The write side of this app has always been durable: a recorded ride is
// checkpointed and queued (lib/rideStore), an SOS raised in a dead zone is
// retried until it lands (lib/sos). The read side was the opposite — every list
// screen refetched from zero on focus, so a rider with no bars saw an empty
// garage, an empty ride history and an empty inbox, even though none of that
// data had changed since the last time they looked at it.
//
// So: keep the last server answer on disk, paint it immediately, and treat the
// network as a refresh rather than a precondition. FeedScreen already did this
// by hand; this module is that pattern made reusable.
//
// AsyncStorage (not files) is right for these: they are lists of a few hundred
// rows at most. The one thing too big for it — a route's full geometry — lives
// in lib/routeCache instead.
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearCachedRoutes } from './routeCache';

// Every key this module owns starts here, so signing out can wipe the lot
// without knowing what was written.
const PREFIX = 'morider.cache.';

type Envelope<T> = { savedAt: number; value: T };

export type CacheMeta = {
  /** False until the disk read has finished — the first paint may be empty. */
  hydrated: boolean;
  /** When the cached value was written, or null if nothing was cached. */
  savedAt: number | null;
};

export async function readCache<T>(key: string): Promise<Envelope<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    // Written by an older shape, or truncated: treat as a miss rather than
    // handing a screen something it can't render.
    if (env == null || typeof env !== 'object' || !('value' in env)) return null;
    return env;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    // Best effort: a full disk must never break the screen that is otherwise
    // working fine against the network.
  }
}

export async function removeCache(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

// In-memory caches (module-level lists kept across navigation) survive a sign-out
// within the same process, so they have to be reset alongside the disk. Modules
// that keep one register a resetter here.
const resetters = new Set<() => void>();

export function registerCacheReset(fn: () => void): void {
  resetters.add(fn);
}

/**
 * Drops every cached read — called on sign-out and on a 401. The next rider to
 * use this phone must not see the previous one's rides, garage or inbox.
 */
export async function clearOfflineData(): Promise<void> {
  for (const reset of resetters) {
    try {
      reset();
    } catch {
      // ignore
    }
  }
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    // ignore
  }
  await clearCachedRoutes();
}

/**
 * State that persists itself. Behaves like useState, except the initial paint
 * is the last value this key held on disk and every set writes through.
 *
 * The disk read never overwrites a value the screen has already set: a fetch
 * that beats the (asynchronous) hydration is fresher by definition.
 */
export function useCachedState<T>(key: string, initial: T): [T, (next: T) => void, CacheMeta] {
  const [value, setValue] = useState<T>(initial);
  const [meta, setMeta] = useState<CacheMeta>({ hydrated: false, savedAt: null });
  const setBySelf = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readCache<T>(key)
      .then((env) => {
        if (cancelled) return;
        if (env && !setBySelf.current) setValue(env.value);
        setMeta({ hydrated: true, savedAt: env?.savedAt ?? null });
      })
      .catch(() => {
        if (!cancelled) setMeta({ hydrated: true, savedAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setBySelf.current = true;
      setValue(next);
      setMeta({ hydrated: true, savedAt: Date.now() });
      void writeCache(key, next);
    },
    [key],
  );

  return [value, set, meta];
}
