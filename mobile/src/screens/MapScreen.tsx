import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { LongPressEvent, Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { CrashCountdown } from '../components/CrashCountdown';
import { NavBanner } from '../components/NavBanner';
import { useCrashDetection } from '../lib/crashDetection';
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
  const [saving, setSaving] = useState(false);
  const [crashAlarm, setCrashAlarm] = useState(false);
  const [pois, setPois] = useState<POI[]>([]);
  const [poiPoint, setPoiPoint] = useState<Coord | null>(null);
  const [poiName, setPoiName] = useState('');
  const [poiCategory, setPoiCategory] = useState<string>('cafe');
  const [savingPoi, setSavingPoi] = useState(false);

  // Turn-by-turn state (active while recording on a followed route).
  const [navStep, setNavStep] = useState<NavStep | null>(null);
  const [navDist, setNavDist] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);

  const subscription = useRef<Location.LocationSubscription | null>(null);
  const samples = useRef<Sample[]>([]);
  const lastCoord = useRef<Coord | null>(null);
  const startedAt = useRef<Date | null>(null);
  const mapRef = useRef<MapView | null>(null);
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
      subscription.current?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function centerOnUser(initial = false) {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
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
      .then(({ steps, points }) => {
        if (steps.length === 0) return;
        navSteps.current = steps;
        navIdx.current = 0;
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
      return false;
    }
    const step = steps[idx];
    const d = distanceM(pos, step);
    setNavStep(step);
    setNavDist(d);
    maybeSpeak(spoken.current, idx, step, d, voiceRef.current);
    return true;
  }

  async function startRecording() {
    if (!hasPermission) {
      Alert.alert('İzin gerekli', 'Sürüş kaydı için konum izni vermelisiniz.');
      return;
    }
    setPath([]);
    setDistance(0);
    setSpeed(0);
    samples.current = [];
    lastCoord.current = null;
    startedAt.current = new Date();
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
    if (followPath.length > 1) {
      const routePts = followPath.map((p) => ({ lat: p.latitude, lon: p.longitude }));
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        .then((loc) => planInitialRoute(routePts, { lat: loc.coords.latitude, lon: loc.coords.longitude }))
        .then(({ steps, points }) => {
          if (steps.length > 0) navSteps.current = steps;
          // Redraw the guide so the lead-in from the rider's position is visible.
          if (points.length > 1) {
            setFollowPath(points.map((p) => ({ latitude: p.lat, longitude: p.lon })));
          }
        })
        .catch(() => {});
    }

    subscription.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 3000 },
      (loc) => {
        const coord: Coord = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        if (lastCoord.current) {
          setDistance((d) => d + haversineKm(lastCoord.current as Coord, coord));
        }
        lastCoord.current = coord;
        setSpeed(Math.max(0, (loc.coords.speed ?? 0) * 3.6));
        setPath((p) => [...p, coord]);
        samples.current.push({
          ...coord,
          altitude: loc.coords.altitude ?? 0,
          speed: loc.coords.speed ?? 0,
          ts: new Date(loc.timestamp).toISOString(),
        });
        const navigating = updateNavigation({ lat: coord.latitude, lon: coord.longitude });
        if (navigating) {
          maybeReroute({ lat: coord.latitude, lon: coord.longitude });
        }
        // Google-Maps-style chase cam: tilted, zoomed-in, rotated to heading.
        // Applies to every active ride, not just turn-by-turn navigation.
        const heading = loc.coords.heading ?? -1;
        mapRef.current?.animateCamera(
          {
            center: coord,
            pitch: 55,
            zoom: 17.5,
            ...(heading >= 0 ? { heading } : {}),
          },
          { duration: 700 },
        );
      },
    );
  }

  async function stopRecording() {
    subscription.current?.remove();
    subscription.current = null;
    setRecording(false);
    setSpeed(0);
    navSteps.current = null;
    setNavStep(null);
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
        showsUserLocation
        showsMyLocationButton={false}
        followsUserLocation={false}
        onLongPress={onMapLongPress}
        onRegionChangeComplete={loadPois}
      >
        {followPath.length > 1 && (
          <Polyline coordinates={followPath} strokeColor={colors.accent} strokeWidth={5} lineDashPattern={[2, 8]} />
        )}
        {path.length > 1 && <Polyline coordinates={path} strokeColor={colors.primary} strokeWidth={6} />}
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
        <NavBanner step={navStep} distM={navDist} voiceOn={voiceOn} onToggleVoice={() => setVoiceOn((v) => !v)} />
      ) : (
        <>
          {followPath.length > 1 && (
            <Pressable style={styles.followChip} onPress={clearFollow}>
              <MaterialCommunityIcons name="map-marker-path" size={16} color={colors.accent} />
              <Text style={styles.followChipText}>Rota takipte</Text>
              <MaterialCommunityIcons name="close" size={16} color={colors.textMuted} />
            </Pressable>
          )}

          {/* Recording status badge */}
          <View style={styles.badgeWrap} pointerEvents="none">
            <View style={[styles.badge, recording ? styles.badgeLive : styles.badgeIdle]}>
              <View style={[styles.dot, { backgroundColor: recording ? colors.danger : colors.success }]} />
              <Text style={styles.badgeText}>{recording ? 'KAYITTA' : 'HAZIR'}</Text>
            </View>
          </View>
        </>
      )}

      {/* Recenter button */}
      <Pressable style={styles.locateBtn} onPress={() => centerOnUser(false)}>
        <MaterialCommunityIcons name="crosshairs-gps" size={22} color={colors.text} />
      </Pressable>

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
            <Button title="Sürüşü Başlat" icon="motorbike" onPress={startRecording} loading={saving} />
            <View style={{ height: spacing.sm }} />
            <Button title="Grup Sürüşü" variant="ghost" icon="account-group" onPress={() => navigation.navigate('GroupJoin')} />
          </>
        )}
      </Card>

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
  followChip: {
    position: 'absolute',
    top: 64,
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
