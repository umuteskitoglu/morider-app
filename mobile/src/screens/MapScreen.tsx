import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { LongPressEvent, Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { CrashCountdown } from '../components/CrashCountdown';
import { NavBanner } from '../components/NavBanner';
import { NavSummaryBar } from '../components/NavSummaryBar';
import { PlaceSearch } from '../components/PlaceSearch';
import { Place } from '../lib/geocode';
import { darkMapStyle } from '../lib/mapStyle';
import { useCrashDetection } from '../lib/crashDetection';
import { useLeanAngle } from '../lib/useLeanAngle';
import { call112, composeEmergencySMS, getEmergencyContact } from '../lib/emergency';
import {
  advanceStep,
  distanceM,
  LatLon,
  maybeSpeak,
  NavStep,
  newRerouteState,
  offRouteTick,
  planInitialRoute,
  rerouteFromPosition,
  speakRerouted,
  SpokenState,
  stopSpeaking,
} from '../lib/navigation';
import { POI, POI_CATEGORIES, POI_LABELS, poiColor, poiIcon } from '../lib/poi';
import { setRideLocationHandler, startRideLocation, stopRideLocation } from '../lib/backgroundLocation';
import { RideDashboard } from '../components/RideDashboard';
import { api, errorMessage } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type Sample = Coord & { altitude: number; speed: number; ts: string };
type Props = NativeStackScreenProps<RideStackParams, 'RideMain'>;

const INITIAL_REGION: Region = {
  latitude: 41.0082,
  longitude: 28.9784,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// Distance (km) still to drive: from the rider to the nearest guide vertex,
// then along the remaining geometry to the end. Self-correcting (recomputed each
// fix) so it stays right across reroutes without baseline bookkeeping.
function remainingKmAlong(route: LatLon[], pos: LatLon): number {
  if (route.length < 2) return 0;
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < route.length; i++) {
    const d = distanceM(pos, route[i]);
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  let m = best;
  for (let i = nearest; i < route.length - 1; i++) m += distanceM(route[i], route[i + 1]);
  return m / 1000;
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

export default function MapScreen({ route, navigation }: Props) {
  const followRouteId = route.params?.followRouteId;
  const [hasPermission, setHasPermission] = useState(false);
  const [recording, setRecording] = useState(false);
  const [path, setPath] = useState<Coord[]>([]);
  const [followPath, setFollowPath] = useState<Coord[]>([]);
  const [distance, setDistance] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [heading, setHeading] = useState(-1);
  const [altitude, setAltitude] = useState(0);
  const [viewMode, setViewMode] = useState<'map' | 'dash'>('map');
  const [saving, setSaving] = useState(false);
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

  // Track peak lean over the whole ride so it can be saved on the ride.
  const { lean } = useLeanAngle(recording);
  const maxLeanRight = useRef(0);
  const maxLeanLeft = useRef(0);
  useEffect(() => {
    if (!recording) return;
    if (lean > maxLeanRight.current) maxLeanRight.current = lean;
    if (-lean > maxLeanLeft.current) maxLeanLeft.current = -lean;
  }, [lean, recording]);

  const samples = useRef<Sample[]>([]);
  const lastCoord = useRef<Coord | null>(null);
  const startedAt = useRef<Date | null>(null);
  const mapRef = useRef<MapView | null>(null);
  // Chase-cam pitch/zoom are applied once at the first fix; later fixes only
  // pan/rotate. Re-applying pitch every fix made the map jolt "up" each point.
  const camPrimed = useRef(false);
  // Cleared on unmount so a startRideLocation() that resolves after the screen
  // is gone doesn't leave the foreground service (and its notification) running.
  const alive = useRef(true);
  const navSteps = useRef<NavStep[] | null>(null);
  const navIdx = useRef(0);
  const spoken = useRef<SpokenState>({ idx: -1, far: false, near: false });
  const voiceRef = useRef(true);
  voiceRef.current = voiceOn;
  // The watch callback closes over render-time state, so the guide geometry it
  // checks for deviation lives in a ref kept in sync with followPath.
  const routePointsRef = useRef<LatLon[]>([]);
  const reroute = useRef(newRerouteState());

  useEffect(() => {
    routePointsRef.current = followPath.map((p) => ({ lat: p.latitude, lon: p.longitude }));
  }, [followPath]);

  // Load a saved route to follow when navigated here with followRouteId.
  useEffect(() => {
    if (!followRouteId) {
      setFollowPath([]);
      return;
    }
    (async () => {
      try {
        const { data } = await api.get(`/api/routes/${followRouteId}`);
        const pts: Coord[] = (data.points ?? []).map((p: { lat: number; lon: number }) => ({
          latitude: p.lat,
          longitude: p.lon,
        }));
        setFollowPath(pts);
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
  }, [followRouteId]);

  function clearFollow() {
    navigation.setParams({ followRouteId: undefined });
  }

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setHasPermission(granted);
      if (granted) {
        await centerOnUser(true);
      }
    })();
    return () => {
      // Leaving the screen mid-ride must tear down the foreground service, or
      // the GPS notification (and battery drain) would outlive the screen.
      alive.current = false;
      setRideLocationHandler(null);
      void stopRideLocation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Maps-style: keep the screen on for the whole ride so it never dims/locks
  // mid-navigation. Released as soon as recording stops (or the screen unmounts).
  useEffect(() => {
    if (!recording) return;
    const tag = 'morider-ride';
    void activateKeepAwakeAsync(tag);
    return () => {
      void deactivateKeepAwake(tag);
    };
  }, [recording]);

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
        { center: c, pitch: 55, zoom: 17.5, ...(heading >= 0 ? { heading } : {}) },
        { duration: 500 },
      );
    }
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

  async function emergencyProtocol() {
    setCrashAlarm(false);
    const c = lastCoord.current;
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
      contact
        ? 'SMS hazırlanamadı. 112 aransın mı?'
        : 'Kayıtlı acil durum kişisi yok (Profil > Acil Durum Kişisi). 112 aransın mı?',
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
    if (!offRouteTick(reroute.current, routePointsRef.current, pos)) return;
    reroute.current.inFlight = true;
    rerouteFromPosition(routePointsRef.current, pos)
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
    if (!hasPermission) {
      Alert.alert('İzin gerekli', 'Sürüş kaydı için konum izni vermelisiniz.');
      return;
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

    setPath([]);
    setDistance(0);
    setSpeed(0);
    samples.current = [];
    lastCoord.current = null;
    startedAt.current = new Date();
    maxLeanRight.current = 0;
    maxLeanLeft.current = 0;
    camPrimed.current = false;
    setRecording(true);

    // Following a saved route → plan turn-by-turn from the rider's *current*
    // position (best effort; without steps the dashed guide line still shows).
    // Planning from here, not the route's stored start, means a rider who
    // begins somewhere else gets a guide that leads them onto the route instead
    // of pointing back at its original start point.
    navSteps.current = null;
    navIdx.current = 0;
    spoken.current = { idx: -1, far: false, near: false };
    reroute.current = newRerouteState();
    setNavStep(null);
    setNavNext(null);
    setFollowCam(true);
    if (followPath.length > 1) {
      const routePts = followPath.map((p) => ({ lat: p.latitude, lon: p.longitude }));
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
            setFollowPath(points.map((p) => ({ latitude: p.lat, longitude: p.lon })));
          }
        })
        .catch(() => {});
    }

    // Stream GPS through the background-capable foreground service so the ride
    // keeps recording when the rider locks the screen or switches apps (the
    // service keeps the JS process alive, so these callbacks keep firing).
    setRideLocationHandler(({ lat, lon, speed, heading, altitude, ts }) => {
      const coord: Coord = { latitude: lat, longitude: lon };
      if (lastCoord.current) {
        setDistance((d) => d + haversineKm(lastCoord.current as Coord, coord));
      }
      lastCoord.current = coord;
      setSpeed(speed);
      setHeading(heading);
      setAltitude(altitude);
      setPath((p) => [...p, coord]);
      samples.current.push({
        ...coord,
        altitude,
        // RideFix speed is km/h; telemetry stores raw m/s like before.
        speed: speed / 3.6,
        ts,
      });
      const navigating = updateNavigation({ lat, lon });
      if (navigating) {
        maybeReroute({ lat, lon });
        setRemainingKm(remainingKmAlong(routePointsRef.current, { lat, lon }));
      }
      // Google-Maps-style chase cam: tilted, zoomed-in, rotated to heading.
      // Pitch/zoom are set once (camPrimed); later fixes only pan + rotate so
      // the map doesn't jolt "up" on every point. Suspended while the rider has
      // panned the map by hand (followCam off). No-op while backgrounded.
      if (followCamRef.current) {
        if (!camPrimed.current) {
          camPrimed.current = true;
          mapRef.current?.animateCamera(
            { center: coord, pitch: 55, zoom: 17.5, ...(heading >= 0 ? { heading } : {}) },
            { duration: 700 },
          );
        } else {
          mapRef.current?.animateCamera(
            { center: coord, ...(heading >= 0 ? { heading } : {}) },
            { duration: 700 },
          );
        }
      }
    });
    await startRideLocation({
      notificationTitle: 'Morider sürüş kaydı',
      notificationBody: 'Sürüşün kaydediliyor — mesafe, hız ve rota.',
    });
    // Screen left while awaiting → don't leave the service running.
    if (!alive.current) {
      setRideLocationHandler(null);
      void stopRideLocation();
    }
  }

  async function stopRecording() {
    setRideLocationHandler(null);
    await stopRideLocation();
    setRecording(false);
    setViewMode('map');
    setSpeed(0);
    navSteps.current = null;
    setNavStep(null);
    setNavNext(null);
    setRemainingKm(0);
    setFollowCam(true);
    stopSpeaking();
    // Reset the chase cam tilt back to a flat overview.
    mapRef.current?.animateCamera({ pitch: 0, heading: 0 });

    const start = startedAt.current ?? new Date();
    const end = new Date();

    if (samples.current.length < 2) {
      Alert.alert('Sürüş çok kısa', 'Kaydetmek için biraz daha sürmelisin.');
      return;
    }

    try {
      setSaving(true);
      const { data: ride } = await api.post('/api/rides', {
        distance,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        elevation_gain: 0,
        max_lean_right: Math.round(maxLeanRight.current),
        max_lean_left: Math.round(maxLeanLeft.current),
      });

      await api.post('/api/telemetry', {
        points: samples.current.map((s) => ({
          ride_id: ride.id,
          lat: s.latitude,
          lon: s.longitude,
          altitude: s.altitude,
          speed: s.speed,
          ts: s.ts,
        })),
      });

      Alert.alert('🏁 Sürüş kaydedildi', `${distance.toFixed(2)} km kaydedildi.`);
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={INITIAL_REGION}
        customMapStyle={darkMapStyle}
        userInterfaceStyle="dark"
        showsBuildings
        showsUserLocation
        showsMyLocationButton={false}
        followsUserLocation={false}
        onLongPress={onMapLongPress}
        onRegionChangeComplete={loadPois}
        onPanDrag={() => {
          // Rider grabbed the map mid-ride → pause chase cam, offer "recenter".
          if (recording) setFollowCam(false);
        }}
      >
        {followPath.length > 1 && (
          <Polyline coordinates={followPath} strokeColor={colors.accent} strokeWidth={5} lineDashPattern={[2, 8]} />
        )}
        {path.length > 1 && <Polyline coordinates={path} strokeColor={colors.primary} strokeWidth={6} />}
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
      </MapView>

      {/* Turn-by-turn banner replaces the status chrome while navigating */}
      {recording && navStep ? (
        <NavBanner
          step={navStep}
          distM={navDist}
          nextStep={navNext}
          voiceOn={voiceOn}
          onToggleVoice={() => setVoiceOn((v) => !v)}
        />
      ) : (
        <>
          {/* Destination search (idle): pick a target to navigate to */}
          {!recording && (
            <PlaceSearch onPick={onPickDestination} near={near} placeholder="Nereye? Hedef ara…" style={styles.search} />
          )}

          {destination ? (
            <Pressable style={styles.followChip} onPress={clearDestination}>
              <MaterialCommunityIcons name="flag-checkered" size={16} color={colors.accent} />
              <Text style={styles.followChipText}>Hedefe gidiliyor</Text>
              <MaterialCommunityIcons name="close" size={16} color={colors.textMuted} />
            </Pressable>
          ) : followPath.length > 1 ? (
            <Pressable style={styles.followChip} onPress={clearFollow}>
              <MaterialCommunityIcons name="map-marker-path" size={16} color={colors.accent} />
              <Text style={styles.followChipText}>Rota takipte</Text>
              <MaterialCommunityIcons name="close" size={16} color={colors.textMuted} />
            </Pressable>
          ) : null}

          {/* Recording badge — only mid-ride; idle uses the search bar instead */}
          {recording && (
            <View style={styles.badgeWrap} pointerEvents="none">
              <View style={[styles.badge, styles.badgeLive]}>
                <View style={[styles.dot, { backgroundColor: colors.danger }]} />
                <Text style={styles.badgeText}>KAYITTA</Text>
              </View>
            </View>
          )}
        </>
      )}

      {/* Resume the chase cam after panning the map by hand (navigation only) */}
      {recording && navStep && !followCam && (
        <Pressable style={styles.recenterBtn} onPress={recenterChase}>
          <MaterialCommunityIcons name="navigation" size={18} color="#fff" />
          <Text style={styles.recenterText}>Ortala</Text>
        </Pressable>
      )}

      {/* Toggle to the full-screen ride dashboard — hidden during active nav to
          keep the navigation view clean. */}
      {!(recording && navStep) && (
        <Pressable style={styles.dashBtn} onPress={() => setViewMode('dash')}>
          <MaterialCommunityIcons name="gauge" size={22} color={colors.text} />
        </Pressable>
      )}

      {/* Recenter button (idle / free ride). Mid-ride it also resumes the chase
          cam if the rider had panned the map away. */}
      {!(recording && navStep) && (
        <Pressable style={styles.locateBtn} onPress={() => (recording ? recenterChase() : centerOnUser(false))}>
          <MaterialCommunityIcons name="crosshairs-gps" size={22} color={colors.text} />
        </Pressable>
      )}

      {/* While navigating, a compact ETA bar replaces the big stats panel */}
      {recording && navStep ? (
        <NavSummaryBar
          remainingKm={remainingKm}
          remainingMin={routeKm > 0 ? routeMin * (remainingKm / routeKm) : 0}
          onStop={stopRecording}
        />
      ) : (
        <Card style={styles.panel}>
          <View style={styles.stats}>
            <Stat icon="map-marker-distance" label="Mesafe" value={distance.toFixed(2)} unit="km" />
            <Stat icon="speedometer" label="Hız" value={speed.toFixed(0)} unit="km/s" />
            <Stat icon="map-marker-multiple" label="Nokta" value={`${path.length}`} unit="" />
          </View>
          {recording ? (
            <Button title="Sürüşü Bitir" variant="danger" icon="stop-circle" onPress={stopRecording} loading={saving} />
          ) : (
            <>
              <Button title={destination ? 'Navigasyonu Başlat' : 'Sürüşü Başlat'} icon="motorbike" onPress={startRecording} loading={saving} />
              <View style={{ height: spacing.sm }} />
              <Button title="Grup Sürüşü" variant="ghost" icon="account-group" onPress={() => navigation.navigate('GroupJoin')} />
            </>
          )}
        </Card>
      )}

      {/* Full-screen gauge dashboard overlay; the map stays mounted underneath
          so the chase cam and recorded path are preserved on return. */}
      {viewMode === 'dash' && (
        <RideDashboard
          speed={speed}
          heading={heading}
          altitude={altitude}
          distance={distance}
          samples={samples.current}
          startedAt={startedAt.current}
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
        <Pressable style={styles.poiBackdrop} onPress={() => setPoiPoint(null)}>
          <Pressable style={styles.poiSheet} onPress={() => {}}>
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
    </View>
  );
}

function Stat({ icon, label, value, unit }: { icon: any; label: string; value: string; unit: string }) {
  return (
    <View style={styles.stat}>
      <MaterialCommunityIcons name={icon} size={18} color={colors.primary} style={{ marginBottom: 4 }} />
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
  badgeWrap: { position: 'absolute', top: spacing.lg, left: 0, right: 0, alignItems: 'center' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    ...shadow.card,
  },
  badgeLive: { backgroundColor: 'rgba(255,77,94,0.18)', borderWidth: 1, borderColor: colors.danger },
  badgeIdle: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  badgeText: { color: colors.text, fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  search: { position: 'absolute', top: spacing.md, left: spacing.md, right: spacing.md },
  recenterBtn: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 120,
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
  followChip: {
    position: 'absolute',
    top: 76,
    alignSelf: 'center',
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
  locateBtn: {
    position: 'absolute',
    right: spacing.md,
    bottom: 180,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  dashBtn: {
    position: 'absolute',
    right: spacing.md,
    bottom: 236,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg },
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
  stats: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.md },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '900' },
  statUnit: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
});
