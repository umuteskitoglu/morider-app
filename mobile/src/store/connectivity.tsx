// Whether the phone can currently reach anything.
//
// The app used to have no idea. Every screen found out the hard way, one failed
// request at a time, and the queues that exist for exactly this case
// (lib/rideStore, lib/sos) only drained when the rider happened to open the map
// screen — so a ride recorded on a mountain could sit on disk for days.
//
// Two things come out of knowing: screens can say "this is the saved copy"
// instead of showing an error, and the moment signal comes back we push out
// whatever was waiting, wherever the rider happens to be in the app.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

import { useAuth } from './auth';
import { flushPendingRides } from '../lib/rideStore';
import { flushSOSQueue } from '../lib/sos';
import { showBanner } from '../components/InAppBanner';

type ConnectivityState = {
  online: boolean;
};

const ConnectivityContext = createContext<ConnectivityState | undefined>(undefined);

// Mirrored at module level so non-React callers (api helpers, lib code) can ask
// without threading a hook through. Starts optimistic: assuming offline before
// the first NetInfo event would make the app flash a banner on every launch.
let online = true;

export function isOnline(): boolean {
  return online;
}

// isInternetReachable is null until the reachability probe finishes, and stays
// null on platforms that can't run it — only an explicit false means "connected
// to a network that goes nowhere" (captive portals, a wifi with no uplink).
function readState(s: { isConnected: boolean | null; isInternetReachable: boolean | null | undefined }): boolean {
  return s.isConnected === true && s.isInternetReachable !== false;
}

export function ConnectivityProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [isUp, setIsUp] = useState(true);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const next = readState(state);
      const was = online;
      online = next;
      setIsUp(next);
      // Regaining signal is the only moment worth acting on. Signed-out
      // flushing would just 401 and tear down a session that isn't there.
      if (next && !was && tokenRef.current) void drainQueues();
    });
    return unsubscribe;
  }, []);

  // Launching with a working connection is the other moment worth draining on:
  // the transition handler above never fires when the app was already online,
  // and until now a queued ride only went out if the rider happened to open the
  // Ride tab. Overlapping runs are harmless — both queues are single-flight.
  useEffect(() => {
    if (token && isOnline()) void drainQueues();
  }, [token]);

  const value = useMemo<ConnectivityState>(() => ({ online: isUp }), [isUp]);

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

// Pushes out everything that was waiting for a connection. The rider is told
// about a ride that finally landed — they were shown "İnternet gelince
// otomatik olarak yüklenecek" when it was queued, so this closes that loop —
// but a queued SOS stays silent: by the time it goes out the incident is over
// for the rider, and it is their group that needs to hear about it.
async function drainQueues(): Promise<void> {
  void flushSOSQueue();
  const { sent } = await flushPendingRides();
  if (sent > 0) {
    showBanner(
      'Bekleyen sürüş yüklendi',
      sent === 1 ? 'Kaydedilemeyen bir sürüşün yüklendi.' : `Kaydedilemeyen ${sent} sürüşün yüklendi.`,
      {},
    );
  }
}

export function useConnectivity(): ConnectivityState {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) {
    throw new Error('useConnectivity must be used within ConnectivityProvider');
  }
  return ctx;
}
