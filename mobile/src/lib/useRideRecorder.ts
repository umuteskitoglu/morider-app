// The ride recorder, extracted so a group ride is a *recorded* ride.
//
// Recording used to live inside MapScreen, which meant joining a group ride
// silently traded it away: 300 km with friends produced zero kilometres in your
// profile, no kapışma matches, no elevation, no badge progress. Riders had to
// choose between riding together and having ridden at all.
//
// Everything that makes a ride a ride is here — samples, distance, pause,
// crash-proof checkpointing, saving — and nothing that belongs to a screen.
// Map cameras, turn-by-turn and WebSocket fan-out stay with the caller, which
// receives every fix through `onFix`.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { configureAudioSession } from './audio';
import { RideFix, setRideLocationHandler, startRideLocation, stopRideLocation } from './backgroundLocation';
import {
  CHECKPOINT_INTERVAL_MS,
  checkpointRide,
  clearCheckpoint,
  finalizeDraft,
  newRideId,
  RideDraft,
  RideSummary,
  saveOrQueueRide,
  StoredSample,
} from './rideStore';

export type Coord = { latitude: number; longitude: number };

// Auto-pause thresholds. The gap between MOVING and RESUME is deliberate
// hysteresis: a single jittery fix near the boundary must not flap the ride
// between paused and running.
const MOVING_KMH = 3;
const RESUME_KMH = 6;
const AUTO_PAUSE_AFTER_MS = 60_000;
// Beyond this with no fix, the numbers on screen are history, not telemetry.
const GPS_STALE_MS = 8_000;

export type RideRecorder = {
  recording: boolean;
  paused: boolean;
  autoPaused: boolean;
  gpsStale: boolean;
  saving: boolean;
  /** km */
  distance: number;
  /** km/h */
  speed: number;
  /** degrees, -1 when unknown */
  heading: number;
  /** m */
  altitude: number;
  /** Elapsed time minus every pause. */
  movingMs: number;
  path: Coord[];
  userCoord: Coord | null;
  /** Live sample buffer — a ref's contents, not a snapshot. */
  samples: StoredSample[];
  startedAt: Date | null;
  /** Peak lean recorded so far; fed in by the caller via `trackLean`. */
  trackLean: (lean: number) => void;
  start: () => Promise<boolean>;
  /** Saves (or queues) the ride and returns its summary; null if too short. */
  stop: () => Promise<RideSummary | null>;
  pause: () => void;
  resume: () => void;
};

export function useRideRecorder(onFix?: (fix: RideFix, paused: boolean) => void): RideRecorder {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  const [gpsStale, setGpsStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [distance, setDistance] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [heading, setHeading] = useState(-1);
  const [altitude, setAltitude] = useState(0);
  const [path, setPath] = useState<Coord[]>([]);
  const [userCoord, setUserCoord] = useState<Coord | null>(null);
  const [lastFixAt, setLastFixAt] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const samples = useRef<StoredSample[]>([]);
  const lastCoord = useRef<Coord | null>(null);
  const startedAt = useRef<Date | null>(null);
  const rideId = useRef('');
  const distanceRef = useRef(0);
  distanceRef.current = distance;
  const maxLeanRight = useRef(0);
  const maxLeanLeft = useRef(0);
  // True from the moment the rider ends the ride, so the checkpoint timer's
  // teardown can tell a deliberate stop from the screen going away mid-ride.
  const stopping = useRef(false);
  // Cleared on unmount so a startRideLocation() that resolves after the screen
  // is gone doesn't leave the foreground service (and its notification) running.
  const alive = useRef(true);
  // These lead the state rather than mirroring it: the GPS callback closes over
  // the render that created it.
  const pausedRef = useRef(false);
  const autoPausedRef = useRef(false);
  const pausedMs = useRef(0);
  const pausedSince = useRef<number | null>(null);
  const slowSince = useRef<number | null>(null);
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setRideLocationHandler(null);
      void stopRideLocation();
    };
  }, []);

  // Maps-style: keep the screen on for the whole ride so it never dims or locks
  // mid-navigation.
  useEffect(() => {
    if (!recording) return;
    const tag = 'morider-ride';
    void activateKeepAwakeAsync(tag);
    return () => {
      void deactivateKeepAwake(tag);
    };
  }, [recording]);

  // Ride clock. Moving time excludes every pause, including the one currently
  // running — so the number stops the moment the rider does.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const movingMs = startedAt.current
    ? nowTick -
      startedAt.current.getTime() -
      pausedMs.current -
      (pausedSince.current ? nowTick - pausedSince.current : 0)
    : 0;

  // "No signal" state. Without it a lost fix looks identical to standing still:
  // the speed freezes at its last value and the rider only finds out that the
  // tunnel ate ten kilometres when the ride is saved.
  useEffect(() => {
    if (!recording) {
      setGpsStale(false);
      return;
    }
    const id = setInterval(() => setGpsStale(Date.now() - lastFixAt > GPS_STALE_MS), 2000);
    return () => clearInterval(id);
  }, [recording, lastFixAt]);

  const currentDraft = useCallback((): RideDraft => {
    // Derived fields (ascent, max speed) are left to finalizeDraft — computing
    // them over the whole track once a minute would be pure waste.
    return {
      id: rideId.current || (rideId.current = newRideId()),
      distance: distanceRef.current,
      startTime: (startedAt.current ?? new Date()).toISOString(),
      elevationGain: 0,
      maxLeanRight: maxLeanRight.current,
      maxLeanLeft: maxLeanLeft.current,
      maxSpeed: 0,
      samples: samples.current.slice(),
    };
  }, []);

  // Snapshot the ride to disk while it records, so an OS kill or a crash costs
  // at most a minute of track instead of the whole day.
  useEffect(() => {
    if (!recording) return;
    const write = () => {
      // Skip once the rider has deliberately stopped: this cleanup runs on the
      // re-render that setRecording(false) triggers, which can land after stop()
      // has already cleared the checkpoint — and a checkpoint written back
      // afterwards would offer to "recover" an already-saved ride on the next
      // launch, duplicating it.
      if (stopping.current) return;
      if (!startedAt.current || samples.current.length < 2) return;
      void checkpointRide(currentDraft());
    };
    const id = setInterval(write, CHECKPOINT_INTERVAL_MS);
    return () => {
      clearInterval(id);
      write();
    };
  }, [recording, currentDraft]);

  // `auto` records who initiated it: an auto-pause resumes itself when the bike
  // moves again, but a pause the rider asked for stays until they undo it —
  // otherwise pushing the bike a few metres would silently restart the clock.
  const pauseInternal = useCallback((auto: boolean) => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    autoPausedRef.current = auto;
    pausedSince.current = Date.now();
    slowSince.current = null;
    setPaused(true);
    setAutoPaused(auto);
  }, []);

  const resumeInternal = useCallback((auto: boolean) => {
    if (!pausedRef.current) return;
    if (auto && !autoPausedRef.current) return; // manual pause needs a manual resume
    pausedRef.current = false;
    autoPausedRef.current = false;
    if (pausedSince.current) pausedMs.current += Date.now() - pausedSince.current;
    pausedSince.current = null;
    slowSince.current = null;
    // The gap in the track is not a straight line the rider rode; drop the
    // anchor so the first fix after a stop doesn't draw across the car park.
    lastCoord.current = null;
    setPaused(false);
    setAutoPaused(false);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('İzin gerekli', 'Sürüş kaydı için konum izni vermelisiniz.');
      return false;
    }
    // "Always" permission is what keeps the GPS recording alive when the app is
    // backgrounded (screen locked or switched away). Without it the ride still
    // records while the app is open, so we warn rather than block.
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => null);
    if (bg && bg.status !== 'granted') {
      Alert.alert(
        'Arka plan konumu kapalı',
        'Başka bir uygulamaya geçince sürüş kaydı durabilir. Kesintisiz kayıt için konum iznini "Her zaman" yap.',
      );
    }

    // Voice guidance should duck other apps' audio, not stop it. Configured
    // here rather than at launch: nothing needs an audio session until a ride
    // starts, and activating one at startup was a suspect in launch crashes.
    configureAudioSession();

    setPath([]);
    setDistance(0);
    setSpeed(0);
    samples.current = [];
    lastCoord.current = null;
    startedAt.current = new Date();
    rideId.current = newRideId();
    stopping.current = false;
    distanceRef.current = 0;
    maxLeanRight.current = 0;
    maxLeanLeft.current = 0;
    pausedRef.current = false;
    autoPausedRef.current = false;
    pausedMs.current = 0;
    pausedSince.current = null;
    slowSince.current = null;
    setPaused(false);
    setAutoPaused(false);
    setGpsStale(false);
    setLastFixAt(Date.now());
    setNowTick(Date.now());
    setRecording(true);

    setRideLocationHandler((fix) => {
      const { lat, lon, speed: kmh, heading: hdg, altitude: alt, ts } = fix;
      const coord: Coord = { latitude: lat, longitude: lon };
      setLastFixAt(Date.now());

      // Auto-pause / auto-resume. A red light shouldn't pause the ride, so the
      // rider has to be genuinely stopped for a while; any real movement
      // resumes immediately.
      if (kmh > RESUME_KMH) {
        slowSince.current = null;
        if (pausedRef.current && autoPausedRef.current) resumeInternal(true);
      } else if (kmh < MOVING_KMH && !pausedRef.current) {
        if (slowSince.current == null) slowSince.current = Date.now();
        else if (Date.now() - slowSince.current > AUTO_PAUSE_AFTER_MS) pauseInternal(true);
      }

      // While paused the track is frozen: no distance, no samples, no path.
      // GPS jitter on a parked bike would otherwise add hundreds of phantom
      // metres over a lunch stop.
      if (!pausedRef.current) {
        if (lastCoord.current) {
          setDistance((d) => d + haversineKm(lastCoord.current as Coord, coord));
        }
        setPath((p) => [...p, coord]);
        samples.current.push({
          latitude: lat,
          longitude: lon,
          altitude: alt,
          // RideFix speed is km/h; telemetry stores raw m/s.
          speed: kmh / 3.6,
          ts,
        });
      }

      lastCoord.current = coord;
      setUserCoord(coord);
      setSpeed(kmh);
      setHeading(hdg);
      setAltitude(alt);
      onFixRef.current?.(fix, pausedRef.current);
    });

    await startRideLocation({
      notificationTitle: 'Morider sürüş kaydı',
      notificationBody: 'Sürüşün kaydediliyor — mesafe, hız ve rota.',
    });
    // Screen left while awaiting → don't leave the service running.
    if (!alive.current) {
      setRideLocationHandler(null);
      void stopRideLocation();
      return false;
    }
    return true;
  }, [pauseInternal, resumeInternal]);

  const stop = useCallback(async (): Promise<RideSummary | null> => {
    // Idempotent on purpose. A group session can reach here twice — once from
    // the rider's "leave", once from the teardown that follows it — and a
    // second save would POST the same ride again, because /api/rides has no
    // idempotency key.
    if (stopping.current) return null;
    stopping.current = true;
    // Freeze the clock before anything resets it: if the ride ended while
    // paused, that final pause counts too.
    const finishedMovingMs = startedAt.current
      ? Date.now() -
        startedAt.current.getTime() -
        pausedMs.current -
        (pausedSince.current ? Date.now() - pausedSince.current : 0)
      : 0;
    pausedRef.current = false;
    autoPausedRef.current = false;
    pausedSince.current = null;
    setPaused(false);
    setAutoPaused(false);

    setRideLocationHandler(null);
    await stopRideLocation();
    setRecording(false);
    setSpeed(0);

    if (samples.current.length < 2) {
      await clearCheckpoint();
      return null;
    }

    setSaving(true);
    // saveOrQueueRide writes the ride to disk before it touches the network, so
    // a failed upload is a delay rather than a loss. It never throws.
    const draft = finalizeDraft({ ...currentDraft(), endTime: new Date().toISOString() });
    const res = await saveOrQueueRide(draft);
    setSaving(false);

    return {
      draft,
      uploaded: res.status === 'uploaded',
      kapisma: res.status === 'uploaded' ? res.kapisma : '',
      movingMs: finishedMovingMs,
    };
  }, [currentDraft]);

  const trackLean = useCallback((lean: number) => {
    if (lean > maxLeanRight.current) maxLeanRight.current = lean;
    if (-lean > maxLeanLeft.current) maxLeanLeft.current = -lean;
  }, []);

  return {
    recording,
    paused,
    autoPaused,
    gpsStale,
    saving,
    distance,
    speed,
    heading,
    altitude,
    movingMs,
    path,
    userCoord,
    samples: samples.current,
    startedAt: startedAt.current,
    trackLean,
    start,
    stop,
    pause: () => pauseInternal(false),
    resume: () => resumeInternal(false),
  };
}

function haversineKm(a: Coord, b: Coord): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
