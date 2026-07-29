import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { LongPressEvent, Marker, Polyline, Region } from 'react-native-maps';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, TextField } from '../components/ui';
import { TourTarget } from '../components/TourTarget';
import { CrashCountdown } from '../components/CrashCountdown';
import { NavBanner } from '../components/NavBanner';
import { NavSummaryBar, SpeedPill } from '../components/NavSummaryBar';
import { PlaceSearch } from '../components/PlaceSearch';
import { Place } from '../lib/geocode';
import { darkMapStyle } from '../lib/mapStyle';
import { useCrashDetection } from '../lib/crashDetection';
import { useLeanAngle } from '../lib/useLeanAngle';
import { call112, composeEmergencySMS, getEmergencyContact } from '../lib/emergency';
import { flushSOSQueue, newSosId, raiseSOS } from '../lib/sos';
import {
  advanceStep,
  distanceM,
  LatLon,
  maybeSpeak,
  NavStep,
  nearestVertexAhead,
  newRerouteState,
  offRouteTick,
  planInitialRoute,
  remainingKmFrom,
  rerouteFromPosition,
  shouldReverseRoute,
  speakRerouted,
  SpokenState,
  stopSpeaking,
} from '../lib/navigation';
import { POI, POI_CATEGORIES, POI_LABELS, poiColor, poiIcon } from '../lib/poi';
import { clearCheckpoint, finalizeDraft, flushPendingRides, loadCheckpoint, saveOrQueueRide, setLastRideSummary } from '../lib/rideStore';
import { useRideRecorder } from '../lib/useRideRecorder';
import { RideDashboard } from '../components/RideDashboard';
import { useAuth } from '../store/auth';
import { useBlockedUsers } from '../store/blockedUsers';
import { blockUser } from '../lib/block';
import { fetchNearby, goOffline, heartbeat, NearbyRider } from '../lib/presence';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type Props = NativeStackScreenProps<RideStackParams, 'RideMain'>;

const INITIAL_REGION: Region = {
  latitude: 41.0082,
  longitude: 28.9784,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// Google-Maps navigation route colors: a bright blue fill with a darker blue
// casing/outline drawn underneath it.
const navRouteFill = '#4E9BFF';
const navRouteCasing = '#1A6CD4';

// "1s 24dk" / "24dk" — compact enough to read at a glance.
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

export default function MapScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const followRouteId = route.params?.followRouteId;
  const followReverseParam = route.params?.followReverse;
  const [followPath, setFollowPath] = useState<Coord[]>([]);
  // The followed route as saved (A→B). followPath is the *displayed* guide:
  // the base in the chosen direction, later replaced by the planned geometry
  // (which may include a lead-in from the rider's actual position).
  const [followBase, setFollowBase] = useState<Coord[]>([]);
  const [followReversed, setFollowReversed] = useState(false);
  const [viewMode, setViewMode] = useState<'map' | 'dash'>('map');
  const [crashAlarm, setCrashAlarm] = useState(false);
  const [pois, setPois] = useState<POI[]>([]);
  const [poiPoint, setPoiPoint] = useState<Coord | null>(null);
  const [poiName, setPoiName] = useState('');
  const [poiCategory, setPoiCategory] = useState<string>('cafe');
  const [savingPoi, setSavingPoi] = useState(false);

  // Turn-by-turn state (active while recording on a followed route).
  const [navStep, setNavStep] = useState<NavStep | null>(null);
  const [navNext, setNavNext] = useState<NavStep | null>(null);
  const [navDist, setNavDist] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  // Turn-by-turn steps come from an async plan request that can fail or lag
  // (flaky network, OSRM timeout, slow GPS fix) — without this, a rider who
  // started on a route could get stuck on the plain recording panel forever.
  // Lets them force the Google-style chase view manually while steps are
  // still (or never) loading.
  const [manualNavView, setManualNavView] = useState(false);

  // Destination navigation (Google-Maps style): a searched target the rider is
  // guided to, with the planned route's total distance/duration for the ETA bar.
  const [destination, setDestination] = useState<Coord | null>(null);
  const [near, setNear] = useState<{ lat: number; lon: number } | undefined>();
  const [routeKm, setRouteKm] = useState(0);
  const [routeMin, setRouteMin] = useState(0);
  const [remainingKm, setRemainingKm] = useState(0);
  // Chase cam follows the rider until they pan the map by hand; then a
  // "recenter" button resumes it. The ref is read inside the GPS callback.
  const [followCam, setFollowCam] = useState(true);
  const followCamRef = useRef(true);
  followCamRef.current = followCam;

  // Live "active riders" layer. Only runs while the profile toggle is on and the
  // map is focused; a single tick both heartbeats our position and refreshes the
  // nearby list, so it costs one location fix every ~12s.
  const { user } = useAuth();
  const { isBlocked, refresh: refreshBlocked } = useBlockedUsers();
  const shareLoc = !!user?.share_live_location;
  const [nearby, setNearby] = useState<NearbyRider[]>([]);
  const [selectedRider, setSelectedRider] = useState<NearbyRider | null>(null);
  const headingRef = useRef(-1);
  const speedRef = useRef(0);

  // Position of the last fix, read by the presence tick and the SOS payload.
  const lastCoord = useRef<Coord | null>(null);
  const mapRef = useRef<MapView | null>(null);
  // Chase-cam pitch/zoom are applied once at the first fix; later fixes only
  // pan/rotate. Re-applying pitch every fix made the map jolt "up" each point.
  const camPrimed = useRef(false);
  const navSteps = useRef<NavStep[] | null>(null);
  const navIdx = useRef(0);
  const spoken = useRef<SpokenState>({ idx: -1, far: false, near: false });
  const voiceRef = useRef(true);
  voiceRef.current = voiceOn;
  // The watch callback closes over render-time state, so the guide geometry it
  // checks for deviation lives in a ref kept in sync with followPath.
  const routePointsRef = useRef<LatLon[]>([]);
  const reroute = useRef(newRerouteState());
  // The ride's *target* geometry, captured once when the ride starts and never
  // replaced. Reroutes rejoin this, not the displayed guide: the guide is a
  // plan output, and re-planning against a previous plan compounds any bad
  // geometry it contains instead of healing back toward the followed route.
  const targetPointsRef = useRef<LatLon[]>([]);
  // Rider's progress (vertex index) along the displayed guide, so the
  // remaining-km search only moves forward (see nearestVertexAhead).
  const progressRef = useRef(0);

  // The recorder owns the ride itself; this screen only reacts to each fix with
  // the things that are its own — turn-by-turn and the chase camera.
  const rec = useRideRecorder(({ lat, lon, heading: hdg }) => {
    lastCoord.current = { latitude: lat, longitude: lon };

    const navigating = updateNavigation({ lat, lon });
    if (navigating) {
      maybeReroute({ lat, lon });
      // Forward-only progress along the guide keeps remaining-km monotonic
      // even when the geometry passes near itself (out-and-back, figure-8).
      const { index } = nearestVertexAhead(routePointsRef.current, { lat, lon }, progressRef.current);
      progressRef.current = index;
      setRemainingKm(remainingKmFrom(routePointsRef.current, index, { lat, lon }));
    }

    // Google-Maps-style chase cam: tilted, zoomed-in, rotated to heading.
    // Pitch/zoom are set once (camPrimed); later fixes only pan + rotate so the
    // map doesn't jolt "up" on every point. Suspended while the rider has
    // panned the map by hand. No-op while backgrounded.
    if (!followCamRef.current) return;
    const center = { latitude: lat, longitude: lon };
    if (!camPrimed.current) {
      camPrimed.current = true;
      mapRef.current?.animateCamera(
        { center, pitch: 55, zoom: 17.5, altitude: 300, ...(hdg >= 0 ? { heading: hdg } : {}) },
        { duration: 700 },
      );
    } else {
      mapRef.current?.animateCamera({ center, ...(hdg >= 0 ? { heading: hdg } : {}) }, { duration: 700 });
    }
  });
  const { recording, paused, autoPaused, gpsStale, saving, distance, speed, heading, altitude, path } = rec;
  headingRef.current = heading;
  speedRef.current = speed;

  // Peak lean is still recorded for the summary — it just isn't shown live.
  // Declared after the recorder because it reads `recording` from it.
  const { lean } = useLeanAngle(recording);
  useEffect(() => {
    if (recording) rec.trackLean(lean);
  }, [lean, recording, rec]);

  useEffect(() => {
    routePointsRef.current = followPath.map((p) => ({ lat: p.latitude, lon: p.longitude }));
  }, [followPath]);

  // Load a saved route to follow when navigated here with followRouteId.
  // Direction: an explicit followReverse param wins; otherwise smart default —
  // if the rider stands near the route's *end*, follow it end→start (the
  // "came to work on this route, now riding home" case) instead of guiding
  // them all the way back to the original start.
  useEffect(() => {
    if (!followRouteId) {
      setFollowPath([]);
      setFollowBase([]);
      setFollowReversed(false);
      return;
    }
    (async () => {
      try {
        const { data } = await api.get(`/api/routes/${followRouteId}`);
        const pts: Coord[] = (data.points ?? []).map((p: { lat: number; lon: number }) => ({
          latitude: p.lat,
          longitude: p.lon,
        }));
        let reversed = followReverseParam;
        if (reversed === undefined && pts.length > 1) {
          try {
            // A stale cached fix (rider moved since) would pick the wrong
            // direction, so only trust a recent one before asking for a fresh fix.
            const loc =
              (await Location.getLastKnownPositionAsync({ maxAge: 60_000 })) ??
              (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
            reversed = shouldReverseRoute(
              pts.map((p) => ({ lat: p.latitude, lon: p.longitude })),
              { lat: loc.coords.latitude, lon: loc.coords.longitude },
            );
          } catch {
            reversed = false;
          }
        }
        const shown = reversed ? [...pts].reverse() : pts;
        setFollowBase(pts);
        setFollowReversed(!!reversed);
        setFollowPath(shown);
        if (pts.length > 1) {
          setTimeout(
            () => mapRef.current?.fitToCoordinates(pts, { edgePadding: { top: 100, right: 60, bottom: 220, left: 60 }, animated: true }),
            400,
          );
        }
      } catch {
        // ignore – route just won't be shown as a guide
      }
    })();
  }, [followRouteId, followReverseParam]);

  function clearFollow() {
    navigation.setParams({ followRouteId: undefined, followReverse: undefined });
  }

  // Flip the followed route's direction (A→B ⇄ B→A) before the ride starts.
  function toggleFollowDirection() {
    if (recording || followBase.length < 2) return;
    const reversed = !followReversed;
    setFollowReversed(reversed);
    setFollowPath(reversed ? [...followBase].reverse() : followBase);
    // Any previously previewed ETA belonged to the other direction.
    setRouteKm(0);
    setRouteMin(0);
    setRemainingKm(0);
  }

  useEffect(() => {
    (async () => {
      // Only to centre the map on arrival; the recorder does its own
      // permission handling when a ride actually starts.
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') await centerOnUser(true);
    })();
    // The recorder tears down the foreground service on unmount, so there is
    // nothing for this effect to clean up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On arrival: push out anything the last session couldn't send, and offer to
  // recover a ride that was interrupted rather than stopped.
  useEffect(() => {
    (async () => {
      // An SOS raised in a dead zone gets its second chance here.
      void flushSOSQueue();
      const { sent } = await flushPendingRides();
      if (sent > 0) {
        Alert.alert(
          'Bekleyen sürüş yüklendi',
          sent === 1 ? 'Kaydedilemeyen bir sürüşün yüklendi.' : `Kaydedilemeyen ${sent} sürüşün yüklendi.`,
        );
      }
      const orphan = await loadCheckpoint();
      if (!orphan) return;
      const km = orphan.distance.toFixed(1);
      Alert.alert(
        'Yarım kalan sürüş',
        `Uygulama kapandığında ${km} km'lik bir sürüş kaydediliyordu. Kaydedilsin mi?`,
        [
          { text: 'Sil', style: 'destructive', onPress: () => void clearCheckpoint() },
          {
            text: 'Kaydet',
            onPress: async () => {
              const res = await saveOrQueueRide(finalizeDraft(orphan));
              Alert.alert(
                res.status === 'uploaded' ? '🏁 Sürüş kaydedildi' : 'Sürüş kuyruğa alındı',
                res.status === 'uploaded'
                  ? `${km} km kaydedildi.`
                  : 'İnternet gelince otomatik olarak yüklenecek.',
              );
            },
          },
        ],
      );
    })();
  }, []);

  // Presence loop: heartbeat + refresh nearby riders while sharing is on and the
  // map is focused. Leaving the screen (or turning sharing off) removes us from
  // others' maps immediately.
  useFocusEffect(
    useCallback(() => {
      if (!shareLoc) {
        setNearby([]);
        return;
      }
      let active = true;
      const tick = async () => {
        try {
          let lat: number;
          let lon: number;
          if (lastCoord.current) {
            lat = lastCoord.current.latitude;
            lon = lastCoord.current.longitude;
          } else {
            const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            lat = loc.coords.latitude;
            lon = loc.coords.longitude;
          }
          const isActive = await heartbeat(lat, lon, headingRef.current >= 0 ? headingRef.current : undefined, speedRef.current);
          if (!isActive) return; // sharing turned off server-side
          const riders = await fetchNearby(lat, lon);
          if (active) setNearby(riders);
        } catch {
          // ignore — next tick retries
        }
      };
      tick();
      const timer = setInterval(tick, 12000);
      return () => {
        active = false;
        clearInterval(timer);
        setNearby([]);
        goOffline();
      };
    }, [shareLoc]),
  );

  async function centerOnUser(initial = false) {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setNear({ lat: loc.coords.latitude, lon: loc.coords.longitude });
      mapRef.current?.animateToRegion(
        {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        },
        initial ? 1 : 600,
      );
    } catch {
      // ignore – keep default region
    }
  }

  // Pick a destination by searching: plan a road route from the rider's current
  // position to it and draw it as the guide line. Starting the ride then turns
  // this into full turn-by-turn navigation (startRecording re-plans from here).
  async function onPickDestination(place: Place) {
    const dest: Coord = { latitude: place.lat, longitude: place.lon };
    setDestination(dest);
    clearFollow(); // a destination supersedes any followed saved route
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const cur = { lat: loc.coords.latitude, lon: loc.coords.longitude };
      const { points, distance, duration } = await planInitialRoute(
        [cur, { lat: place.lat, lon: place.lon }],
        cur,
      );
      setRouteKm(distance);
      setRouteMin(duration);
      setRemainingKm(distance);
      if (points.length > 1) {
        const coords = points.map((p) => ({ latitude: p.lat, longitude: p.lon }));
        setFollowPath(coords);
        mapRef.current?.fitToCoordinates(coords, {
          edgePadding: { top: 120, right: 60, bottom: 240, left: 60 },
          animated: true,
        });
      }
    } catch {
      // no route preview; the rider can still start and we'll retry on start
    }
  }

  function clearDestination() {
    setDestination(null);
    setFollowPath([]);
    setRouteKm(0);
    setRouteMin(0);
  }

  // Resume the chase cam after the rider has panned the map away.
  function recenterChase() {
    setFollowCam(true);
    camPrimed.current = false;
    const c = lastCoord.current;
    if (c) {
      mapRef.current?.animateCamera(
        { center: c, pitch: 55, zoom: 17.5, altitude: 300, ...(heading >= 0 ? { heading } : {}) },
        { duration: 500 },
      );
    }
  }

  // Zoom/tilt straight into the chase view the instant a ride starts, like
  // Google Maps — instead of waiting for the first background GPS fix (which can
  // be a few seconds out, making the map look like it never zooms in). Uses the
  // last known position immediately, then refines with a fresh fix.
  function primeChaseCam() {
    const apply = (latitude: number, longitude: number, hd: number) => {
      camPrimed.current = true;
      mapRef.current?.animateCamera(
        { center: { latitude, longitude }, pitch: 55, zoom: 17.5, altitude: 300, ...(hd >= 0 ? { heading: hd } : {}) },
        { duration: 600 },
      );
    };
    if (near) apply(near.lat, near.lon, -1);
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      .then((loc) => apply(loc.coords.latitude, loc.coords.longitude, loc.coords.heading ?? -1))
      .catch(() => {});
  }

  // POIs (mola noktaları) for the visible map area. Refreshed as the viewport
  // settles; skipped when zoomed out too far for individual stops to matter.
  async function loadPois(region: Region) {
    if (region.latitudeDelta > 2 || region.longitudeDelta > 2) {
      setPois([]);
      return;
    }
    try {
      const { data } = await api.get('/api/pois', {
        params: {
          min_lat: region.latitude - region.latitudeDelta / 2,
          max_lat: region.latitude + region.latitudeDelta / 2,
          min_lon: region.longitude - region.longitudeDelta / 2,
          max_lon: region.longitude + region.longitudeDelta / 2,
        },
      });
      setPois(data.pois ?? []);
    } catch {
      // ignore — markers just won't refresh
    }
  }

  function onMapLongPress(e: LongPressEvent) {
    if (recording) return; // don't interrupt an active ride
    setPoiName('');
    setPoiCategory('cafe');
    setPoiPoint(e.nativeEvent.coordinate);
  }

  async function savePoi() {
    if (!poiPoint) return;
    if (!poiName.trim()) {
      Alert.alert('İsim gerekli', 'Mola noktasına bir isim ver.');
      return;
    }
    try {
      setSavingPoi(true);
      const { data } = await api.post('/api/pois', {
        name: poiName.trim(),
        category: poiCategory,
        lat: poiPoint.latitude,
        lon: poiPoint.longitude,
      });
      setPois((prev) => [data, ...prev]);
      setPoiPoint(null);
    } catch (err) {
      Alert.alert('Eklenemedi', errorMessage(err));
    } finally {
      setSavingPoi(false);
    }
  }

  // Crash detection runs while a solo ride is being recorded. Expiry opens a
  // prefilled SMS to the emergency contact (auto-send isn't possible without
  // OS-level SMS permissions) and offers a 112 call.
  useCrashDetection(recording, () => setCrashAlarm(true));

  // The alert goes to the server first: that path is recorded, retried when
  // signal returns, and reaches other riders' phones even when their app is
  // backgrounded. The SMS composer stays as a follow-up for a contact who
  // isn't a Morider user — it can't be the mechanism, because it needs someone
  // conscious to press send.
  async function emergencyProtocol() {
    setCrashAlarm(false);
    const c = lastCoord.current;
    const res = await raiseSOS({
      client_id: newSosId(),
      lat: c?.latitude,
      lon: c?.longitude,
      source: 'crash',
      raised_at: new Date().toISOString(),
    });

    const contact = await getEmergencyContact();
    if (contact) {
      try {
        await composeEmergencySMS(contact, c?.latitude, c?.longitude);
        return;
      } catch {
        // fall through to the 112 prompt
      }
    }
    Alert.alert(
      '🚨 Acil durum',
      (res.status === 'queued'
        ? 'İnternet yok — bildirim sinyal gelince gönderilecek.\n\n'
        : 'Acil durum kaydedildi.\n\n') +
        (contact
          ? 'SMS hazırlanamadı. 112 aransın mı?'
          : 'Kayıtlı acil durum kişisi yok (Profil > Acil Durum Kişisi). 112 aransın mı?'),
      [
        { text: '112 Ara', style: 'destructive', onPress: () => call112() },
        { text: 'Vazgeç', style: 'cancel' },
      ],
    );
  }

  // Sustained deviation from the guide line → plan a fresh path from here that
  // rejoins the route ahead, swap in its steps and redraw the dashed guide.
  function maybeReroute(pos: LatLon): void {
    if (!navSteps.current) return;
    // Deviation is measured against the displayed guide (what the rider is
    // told to follow) — measuring against the target would keep re-firing for
    // the whole length of a legitimate rerouted detour. The re-plan itself
    // targets the original route so bad geometry never compounds.
    if (!offRouteTick(reroute.current, routePointsRef.current, pos)) return;
    const target = targetPointsRef.current.length > 1 ? targetPointsRef.current : routePointsRef.current;
    reroute.current.inFlight = true;
    rerouteFromPosition(target, pos)
      .then(({ steps, points, distance, duration }) => {
        if (steps.length === 0) return;
        navSteps.current = steps;
        navIdx.current = 0;
        // Re-baseline the ETA against the fresh plan (remaining is derived from
        // the new guide geometry, so totals only feed the time estimate).
        if (distance > 0) {
          setRouteKm(distance);
          setRouteMin(duration);
        }
        // Restart deviation counting against the fresh plan; otherwise the
        // stale count re-fires the moment the cooldown expires.
        reroute.current.offCount = 0;
        spoken.current = { idx: -1, far: false, near: false };
        if (points.length > 1) {
          progressRef.current = 0; // fresh guide geometry, restart progress
          setFollowPath(points.map((p) => ({ latitude: p.lat, longitude: p.lon })));
        }
        speakRerouted(voiceRef.current);
      })
      .catch(() => {}) // keep guiding with the old steps; next deviation retries
      .finally(() => {
        reroute.current.lastAt = Date.now();
        reroute.current.inFlight = false;
      });
  }

  // Update the turn-by-turn banner (and voice) for the new position; returns
  // whether navigation is active so the camera can switch to chase mode.
  function updateNavigation(pos: { lat: number; lon: number }): boolean {
    const steps = navSteps.current;
    if (!steps) return false;
    const idx = advanceStep(steps, pos, navIdx.current);
    navIdx.current = idx;
    if (idx >= steps.length) {
      // Route finished — drop the banner but keep recording.
      navSteps.current = null;
      setNavStep(null);
      setNavNext(null);
      setManualNavView(false);
      return false;
    }
    const step = steps[idx];
    const d = distanceM(pos, step);
    setNavStep(step);
    setNavNext(idx + 1 < steps.length ? steps[idx + 1] : null);
    setNavDist(d);
    maybeSpeak(spoken.current, idx, step, d, voiceRef.current);
    return true;
  }

  async function startRecording() {
    // The recorder owns permissions, the audio session, sampling, pause and
    // checkpointing. What stays here is what belongs to *this* screen: the
    // turn-by-turn plan and the chase camera.
    setNavStep(null);
    setNavNext(null);
    setManualNavView(false);
    setFollowCam(true);
    navSteps.current = null;
    navIdx.current = 0;
    spoken.current = { idx: -1, far: false, near: false };
    reroute.current = newRerouteState();
    progressRef.current = 0;
    camPrimed.current = false;

    const ok = await rec.start();
    if (!ok) return;

    // Zoom/tilt in right away so the start feels like Google Maps navigation.
    primeChaseCam();

    // Following a saved route → plan turn-by-turn from the rider's *current*
    // position (best effort; without steps the guide line still shows).
    // Planning from here, not the route's stored start, means a rider who
    // begins somewhere else gets a guide that leads them onto the route instead
    // of pointing back at its original start point.
    if (followPath.length > 1) {
      const routePts = followPath.map((p) => ({ lat: p.latitude, lon: p.longitude }));
      // Pin the ride target now: every later reroute rejoins this geometry,
      // never a previous plan's output (which may carry snap detours).
      targetPointsRef.current = routePts;
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        .then((loc) => planInitialRoute(routePts, { lat: loc.coords.latitude, lon: loc.coords.longitude }))
        .then(({ steps, points, distance, duration }) => {
          if (steps.length > 0) navSteps.current = steps;
          if (distance > 0) {
            setRouteKm(distance);
            setRouteMin(duration);
            setRemainingKm(distance);
          }
          // Redraw the guide so the lead-in from the rider's position is visible.
          if (points.length > 1) {
            progressRef.current = 0;
            setFollowPath(points.map((p) => ({ latitude: p.lat, longitude: p.lon })));
          }
        })
        .catch(() => {});
    }
  }

  async function stopRecording() {
    const summary = await rec.stop();

    setViewMode('map');
    navSteps.current = null;
    targetPointsRef.current = [];
    progressRef.current = 0;
    setNavStep(null);
    setNavNext(null);
    setManualNavView(false);
    setRemainingKm(0);
    setFollowCam(true);
    stopSpeaking();
    // Reset the chase cam tilt back to a flat overview.
    mapRef.current?.animateCamera({ pitch: 0, heading: 0 });

    if (!summary) {
      // Be explicit that nothing was kept — "ride too short" left it ambiguous
      // whether a short ride had still been saved somewhere.
      Alert.alert('Sürüş kaydedilmedi', 'Yeterli konum verisi toplanmadı, bu sürüş kaydedilmedi.');
      return;
    }

    // A finished ride goes to its own screen, not into an alert the rider
    // dismisses in a second.
    setLastRideSummary(summary);
    navigation.navigate('RideSummary');
  }

  const navigating = recording && (navStep != null || manualNavView);
  // Whether the rider is on a followed route or a searched destination — the
  // cases where turn-by-turn *should* eventually kick in, so the manual
  // "switch to navigation view" affordance only shows up when it's relevant.
  const hasRouteToFollow = followPath.length > 1 || destination != null;
  // A/B endpoints of the followed saved route in the chosen direction (absent
  // for destination navigation, which has its own target marker).
  const followStart = followBase.length > 1 ? (followReversed ? followBase[followBase.length - 1] : followBase[0]) : null;
  const followEnd = followBase.length > 1 ? (followReversed ? followBase[0] : followBase[followBase.length - 1]) : null;
  // Keep the floating controls clear of the bottom panel/sheet, whose height
  // depends on the mode: ETA sheet (nav) < one-button panel (recording) <
  // two-button panel (idle).
  const controlsBottom = navigating
    ? insets.bottom + 130
    : recording
      ? insets.bottom + 200
      : insets.bottom + 256;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={INITIAL_REGION}
        customMapStyle={darkMapStyle}
        userInterfaceStyle="dark"
        showsBuildings
        showsUserLocation={!recording}
        showsMyLocationButton={false}
        followsUserLocation={false}
        onLongPress={onMapLongPress}
        onRegionChangeComplete={loadPois}
        onPanDrag={() => {
          // Rider grabbed the map mid-ride → pause chase cam, offer "recenter".
          if (recording) setFollowCam(false);
        }}
      >
        {/* Google-Maps-style route guide: a bright blue fill over a darker
            casing, solid with rounded caps/joins (no thin dashes). The casing is
            drawn first (wider) so the fill sits centered on top of it. */}
        {followPath.length > 1 && (
          <>
            <Polyline coordinates={followPath} strokeColor={navRouteCasing} strokeWidth={12} lineCap="round" lineJoin="round" zIndex={1} />
            <Polyline coordinates={followPath} strokeColor={navRouteFill} strokeWidth={8} lineCap="round" lineJoin="round" zIndex={2} />
          </>
        )}
        {/* The actually-ridden track on top, in the brand red. */}
        {path.length > 1 && (
          <Polyline coordinates={path} strokeColor={colors.primary} strokeWidth={6} lineCap="round" lineJoin="round" zIndex={3} />
        )}
        {/* Start (A) / finish (B) of the followed saved route, in the chosen
            direction, so the rider always sees which way the guide runs. */}
        {followStart && (
          <Marker coordinate={followStart} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={4}>
            <View style={[styles.abPin, styles.aPin]}>
              <Text style={styles.abPinText}>A</Text>
            </View>
          </Marker>
        )}
        {followEnd && (
          <Marker coordinate={followEnd} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={4}>
            <View style={[styles.abPin, styles.bPin]}>
              <Text style={styles.abPinText}>B</Text>
            </View>
          </Marker>
        )}
        {/* Google-Maps-style heading arrow (puck) instead of the round dot while
            riding. `flat` makes the rotation map-relative, so the arrow points
            in the true travel direction even as the chase cam rotates the map. */}
        {recording && rec.userCoord && (
          <Marker
            coordinate={rec.userCoord}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={heading >= 0 ? heading : 0}
            tracksViewChanges={false}
          >
            <View style={styles.navPuck}>
              <MaterialCommunityIcons name="navigation" size={20} color="#fff" />
            </View>
          </Marker>
        )}
        {destination && <Marker coordinate={destination} pinColor={colors.primary} title="Hedef" />}
        {pois.map((p) => (
          <Marker
            key={`poi-${p.id}`}
            coordinate={{ latitude: p.lat, longitude: p.lon }}
            title={p.name}
            description={`${POI_LABELS[p.category as keyof typeof POI_LABELS] ?? p.category} • ${p.owner_name}`}
            tracksViewChanges={false}
          >
            <View style={[styles.poiPin, { borderColor: poiColor(p.category) }]}>
              <MaterialCommunityIcons name={poiIcon(p.category) as any} size={15} color={poiColor(p.category)} />
            </View>
          </Marker>
        ))}
        {/* Active riders sharing their location nearby. Blocked riders are
            hidden client-side — a block doesn't stop them sharing location
            server-side, it just removes them from our own view. Hidden entirely
            while navigating: moving pins competing with the route are pure
            distraction at exactly the moment the rider can least afford it. */}
        {!navigating && nearby.filter((r) => !isBlocked(r.user_id)).map((r) => (
          <Marker
            key={`rider-${r.user_id}`}
            coordinate={{ latitude: r.lat, longitude: r.lon }}
            anchor={{ x: 0.5, y: 0.5 }}
            onPress={() => setSelectedRider(r)}
            tracksViewChanges={false}
          >
            <View style={styles.riderPin}>
              <MaterialCommunityIcons name="motorbike" size={16} color="#fff" />
            </View>
          </Marker>
        ))}
      </MapView>

      {/* Google-Maps-style maneuver header while navigating. Turn-by-turn steps
          load asynchronously and can lag or fail, so `navigating` can be true
          (manual switch) before navStep exists — show a lightweight "hazırlanıyor"
          strip in that gap instead of nothing. */}
      {navigating ? (
        navStep ? (
          <NavBanner
            step={navStep}
            distM={navDist}
            nextStep={navNext}
            voiceOn={voiceOn}
            onToggleVoice={() => setVoiceOn((v) => !v)}
            topInset={insets.top}
          />
        ) : (
          <View style={[styles.navPendingBar, { paddingTop: insets.top + spacing.sm }]}>
            <MaterialCommunityIcons name="routes" size={20} color="#fff" />
            <Text style={styles.navPendingText}>Rota yönlendirmesi hazırlanıyor…</Text>
          </View>
        )
      ) : (
        <>
          {/* Destination search (idle): pick a target to navigate to */}
          {!recording && (
            <PlaceSearch
              onPick={onPickDestination}
              near={near}
              placeholder="Nereye? Hedef ara…"
              style={[styles.search, { top: insets.top + spacing.sm }]}
            />
          )}

          {destination ? (
            <View style={[styles.followRow, { top: insets.top + (recording ? 56 : 64) }]}>
              <Pressable
                style={styles.followChip}
                onPress={clearDestination}
                accessibilityRole="button"
                accessibilityLabel="Hedefe gidiliyor. Hedefi kaldırmak için dokun."
              >
                <MaterialCommunityIcons name="flag-checkered" size={16} color={colors.accent} />
                <Text style={styles.followChipText}>Hedefe gidiliyor</Text>
                <MaterialCommunityIcons name="close" size={16} color={colors.textMuted} />
              </Pressable>
            </View>
          ) : followPath.length > 1 ? (
            <View style={[styles.followRow, { top: insets.top + (recording ? 56 : 64) }]}>
              {/* Direction chip: shows which way the guide runs; tap to flip
                  (disabled mid-ride — the reroute would fight the rider). */}
              <Pressable
                style={styles.followChip}
                onPress={toggleFollowDirection}
                disabled={recording}
                accessibilityRole="button"
                accessibilityLabel={
                  followReversed ? 'Rota ters yönde. Yönü çevirmek için dokun.' : 'Rota düz yönde. Yönü çevirmek için dokun.'
                }
                accessibilityState={{ disabled: recording }}
              >
                <MaterialCommunityIcons name="map-marker-path" size={16} color={colors.accent} />
                <Text style={styles.followChipText}>
                  {followReversed ? 'Rota: B → A (ters)' : 'Rota: A → B'}
                </Text>
                {!recording && <MaterialCommunityIcons name="swap-horizontal" size={16} color={colors.accent} />}
              </Pressable>
              {!recording && (
                <Pressable
                  style={styles.followClose}
                  onPress={clearFollow}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Takip edilen rotayı kaldır"
                >
                  <MaterialCommunityIcons name="close" size={16} color={colors.textMuted} />
                </Pressable>
              )}
            </View>
          ) : null}

          {/* Recording badge — only mid free-ride; idle uses the search bar */}
          {recording && (
            <View style={[styles.badgeWrap, { top: insets.top + spacing.sm }]} pointerEvents="none">
              <View style={[styles.badge, paused ? styles.badgePaused : styles.badgeLive]}>
                <View
                  style={[styles.dot, { backgroundColor: paused ? colors.warning : colors.danger }]}
                />
                <Text style={styles.badgeText}>
                  {paused ? (autoPaused ? 'Otomatik duraklatıldı' : 'Duraklatıldı') : 'Kayıtta'}
                </Text>
              </View>
              {gpsStale && (
                <View style={[styles.badge, styles.badgeGps]}>
                  <MaterialCommunityIcons name="crosshairs-off" size={14} color={colors.warning} />
                  <Text style={styles.badgeText}>GPS sinyali zayıf</Text>
                </View>
              )}
            </View>
          )}
        </>
      )}

      {/* Current-speed circle (Google bottom-left) while navigating */}
      {navigating && <SpeedPill speed={speed} bottomInset={insets.bottom} />}

      {/* Resume the chase cam after panning the map by hand (navigation only) */}
      {navigating && !followCam && (
        <Pressable
          style={[styles.recenterBtn, { bottom: insets.bottom + 110 }]}
          onPress={recenterChase}
          accessibilityRole="button"
          accessibilityLabel="Haritayı konumuma geri ortala"
        >
          <MaterialCommunityIcons name="navigation" size={18} color="#fff" />
          <Text style={styles.recenterText}>Ortala</Text>
        </Pressable>
      )}

      {/* Floating controls (right): dashboard gauges + recenter */}
      <View style={[styles.controls, { bottom: controlsBottom }]} pointerEvents="box-none">
        <Pressable
          style={styles.fab}
          onPress={() => setViewMode('dash')}
          accessibilityRole="button"
          accessibilityLabel="Gösterge panelini aç"
        >
          <MaterialCommunityIcons name="gauge" size={24} color={colors.primary} />
        </Pressable>
        {!navigating && (
          <Pressable
            style={styles.fab}
            onPress={() => (recording ? recenterChase() : centerOnUser(false))}
            accessibilityRole="button"
            accessibilityLabel="Konumuma ortala"
          >
            <MaterialCommunityIcons name="crosshairs-gps" size={24} color={colors.text} />
          </Pressable>
        )}
      </View>

      {/* While navigating, the Google-style ETA sheet replaces the stats panel */}
      {navigating ? (
        <NavSummaryBar
          remainingKm={remainingKm}
          remainingMin={routeKm > 0 ? routeMin * (remainingKm / routeKm) : 0}
          onStop={stopRecording}
          bottomInset={insets.bottom}
        />
      ) : (
        <View style={[styles.panel, { paddingBottom: insets.bottom + spacing.md }]}>
          <View style={styles.stats}>
            <Stat icon="map-marker-distance" label="Mesafe" value={distance.toFixed(2)} unit="km" />
            <View style={styles.statDivider} />
            {/* `--` rather than a stale number: a frozen speed reading is
                indistinguishable from standing still. */}
            <Stat icon="speedometer" label="Hız" value={gpsStale ? '--' : speed.toFixed(0)} unit="km/s" />
            <View style={styles.statDivider} />
            {/* Live lean angle used to sit here. Showing a rider their peak
                lean *while cornering* rewards looking at the screen mid-corner;
                it belongs in the post-ride summary, and that is where it is now. */}
            <Stat icon="timer-outline" label="Süre" value={fmtDuration(rec.movingMs)} unit="" />
          </View>
          {recording && hasRouteToFollow && (
            // Turn-by-turn steps load async and can lag or fail — don't force
            // the switch, but let the rider jump into the chase/nav view
            // themselves instead of being stuck on the plain stats panel.
            <Pressable
              style={styles.switchToNavRow}
              onPress={() => setManualNavView(true)}
              accessibilityRole="button"
              accessibilityLabel="Navigasyon görünümüne geç"
            >
              <MaterialCommunityIcons name="navigation-variant" size={16} color={colors.accent} />
              <Text style={styles.switchToNavText}>Navigasyon görünümüne geç</Text>
            </Pressable>
          )}
          {recording ? (
            <View style={styles.rideActions}>
              <View style={styles.flex}>
                <Button
                  title={paused ? 'Devam Et' : 'Duraklat'}
                  variant="ghost"
                  icon={paused ? 'play' : 'pause'}
                  onPress={() => (paused ? rec.resume() : rec.pause())}
                />
              </View>
              <View style={styles.flex}>
                <Button title="Sürüşü Bitir" variant="danger" icon="stop-circle" onPress={stopRecording} loading={saving} />
              </View>
            </View>
          ) : (
            <>
              {/* TourTarget ids let the onboarding tutorial spotlight these. */}
              <TourTarget id="ride.start">
                <Button
                  title={destination || followPath.length > 1 ? 'Navigasyonu Başlat' : 'Sürüşü Başlat'}
                  icon="motorbike"
                  onPress={startRecording}
                  loading={saving}
                />
              </TourTarget>
              <View style={{ height: spacing.sm }} />
              <TourTarget id="ride.group">
                <Button title="Grup Sürüşü" variant="ghost" icon="account-group" onPress={() => navigation.navigate('GroupJoin')} />
              </TourTarget>
            </>
          )}
        </View>
      )}

      {/* Full-screen gauge dashboard overlay; the map stays mounted underneath
          so the chase cam and recorded path are preserved on return. */}
      {viewMode === 'dash' && (
        <RideDashboard
          speed={speed}
          heading={heading}
          altitude={altitude}
          distance={distance}
          samples={rec.samples}
          startedAt={rec.startedAt}
          recording={recording}
          saving={saving}
          onClose={() => setViewMode('map')}
          onStop={stopRecording}
        />
      )}

      <CrashCountdown visible={crashAlarm} onCancel={() => setCrashAlarm(false)} onExpire={emergencyProtocol} />

      {/* Add a POI (mola noktası) at the long-pressed coordinate */}
      <Modal
        visible={poiPoint != null}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setPoiPoint(null)}
      >
        <Pressable
          style={styles.poiBackdrop}
          onPress={() => setPoiPoint(null)}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        >
          <Pressable style={styles.poiSheet} onPress={() => {}} accessible={false}>
            <Text style={styles.poiTitle}>Mola Noktası Ekle</Text>
            <Text style={styles.poiSub}>
              Motorcu dostu bir yer mi buldun? Herkesin haritasında görünecek.
            </Text>
            <TextField label="İsim" value={poiName} onChangeText={setPoiName} placeholder="Şelale Kafe" />
            <View style={styles.poiPillRow}>
              {POI_CATEGORIES.map((cat) => {
                const active = poiCategory === cat;
                return (
                  <Pressable
                    key={cat}
                    style={[styles.poiPill, active && { borderColor: poiColor(cat), backgroundColor: 'rgba(255,255,255,0.06)' }]}
                    onPress={() => setPoiCategory(cat)}
                  >
                    <MaterialCommunityIcons
                      name={poiIcon(cat) as any}
                      size={15}
                      color={active ? poiColor(cat) : colors.textMuted}
                    />
                    <Text style={[styles.poiPillText, active && { color: colors.text }]}>{POI_LABELS[cat]}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ height: spacing.sm }} />
            <Button title="Kaydet" icon="map-marker-plus" onPress={savePoi} loading={savingPoi} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Nearby rider card → start a direct message */}
      <Modal
        visible={selectedRider != null}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={() => setSelectedRider(null)}
      >
        <Pressable
          style={styles.poiBackdrop}
          onPress={() => setSelectedRider(null)}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        >
          <Pressable style={styles.riderSheet} onPress={() => {}} accessible={false}>
            {selectedRider?.avatar_url ? (
              <Image source={{ uri: apiBaseURL() + selectedRider.avatar_url }} style={styles.riderAvatar} />
            ) : (
              <View style={styles.riderAvatarFallback}>
                <MaterialCommunityIcons name="account" size={28} color="#fff" />
              </View>
            )}
            <Text style={styles.riderName}>{selectedRider?.name}</Text>
            <Text style={styles.poiSub}>Yakında aktif sürücü</Text>
            <View style={{ height: spacing.sm }} />
            <Button
              title="Profili Gör"
              icon="account"
              variant="ghost"
              onPress={() => {
                const r = selectedRider;
                setSelectedRider(null);
                if (!r) return;
                (navigation.getParent() as any)?.navigate('Profile', {
                  screen: 'UserProfile',
                  params: { userId: r.user_id, name: r.name },
                });
              }}
            />
            <View style={{ height: spacing.sm }} />
            <Button
              title="Mesaj Gönder"
              icon="message-text"
              onPress={() => {
                const r = selectedRider;
                setSelectedRider(null);
                if (!r) return;
                (navigation.getParent() as any)?.navigate('Chat', {
                  screen: 'ChatThread',
                  params: { userId: r.user_id, name: r.name, avatarUrl: r.avatar_url },
                });
              }}
            />
            <View style={{ height: spacing.xs }} />
            <Button
              title="Engelle"
              icon="cancel"
              variant="ghost"
              onPress={() => {
                const r = selectedRider;
                if (!r) return;
                Alert.alert('Kullanıcıyı engelle', `${r.name} artık sana mesaj gönderemez ve haritada görünmez. Emin misin?`, [
                  { text: 'Vazgeç', style: 'cancel' },
                  {
                    text: 'Engelle',
                    style: 'destructive',
                    onPress: async () => {
                      setSelectedRider(null);
                      try {
                        await blockUser(r.user_id);
                        await refreshBlocked();
                      } catch {
                        Alert.alert('Hata', 'Engellenemedi, tekrar dene.');
                      }
                    },
                  },
                ]);
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Stat({ icon, label, value, unit }: { icon: any; label: string; value: string; unit: string }) {
  return (
    <View style={styles.stat} accessibilityRole="text" accessibilityLabel={`${label}: ${value} ${unit}`}>
      <MaterialCommunityIcons name={icon} size={18} color={colors.primary} />
      <Text style={styles.statValue}>
        {value}
        {unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  badgeWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    ...shadow.card,
  },
  badgeLive: { backgroundColor: 'rgba(255,77,94,0.18)', borderWidth: 1, borderColor: colors.danger },
  badgePaused: { backgroundColor: 'rgba(255,176,32,0.18)', borderWidth: 1, borderColor: colors.warning },
  badgeGps: {
    backgroundColor: 'rgba(255,176,32,0.18)',
    borderWidth: 1,
    borderColor: colors.warning,
    marginTop: spacing.xs,
    gap: spacing.xs,
  },
  rideActions: { flexDirection: 'row', gap: spacing.sm },
  flex: { flex: 1 },
  badgeIdle: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  badgeText: { color: colors.text, fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  search: { position: 'absolute', left: spacing.md, right: spacing.md },
  recenterBtn: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    ...shadow.card,
  },
  recenterText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  followRow: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  followChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    ...shadow.card,
  },
  followChipText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  followClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  abPin: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  aPin: { backgroundColor: '#2E9E5B' },
  bPin: { backgroundColor: '#D93F33' },
  abPinText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  navPuck: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1A73E8',
    borderWidth: 2.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  navPendingBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(20,20,24,0.9)',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    ...shadow.card,
  },
  navPendingText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  switchToNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  switchToNavText: { color: colors.accent, fontSize: 13, fontWeight: '800' },
  controls: { position: 'absolute', right: spacing.md, alignItems: 'center', gap: spacing.sm },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    ...shadow.card,
  },
  poiPin: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  riderPin: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  riderSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    alignItems: 'center',
    gap: spacing.xs,
  },
  riderAvatar: { width: 64, height: 64, borderRadius: 32 },
  riderAvatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  riderName: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: spacing.xs },
  poiBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  poiSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  poiTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  poiSub: { color: colors.textMuted, fontSize: 13 },
  poiPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  poiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  poiPillText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.lg,
  },
  stat: { alignItems: 'center', justifyContent: 'center', flex: 1, gap: spacing.xs },
  statDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: spacing.xs, backgroundColor: colors.border },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'] },
  statUnit: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  // No textTransform: iOS uppercases locale-independently and mangles Turkish
  // ("Yatış" → "YATIS"). 13px reads better than 11px at a glance, too.
  statLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
});
