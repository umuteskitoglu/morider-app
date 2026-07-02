import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from 'react-native';
import MapView, { MapPressEvent, Marker, Polyline } from 'react-native-maps';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { PlaceSearch } from '../components/PlaceSearch';
import { Place } from '../lib/geocode';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type PlanInfo = { distance: number; duration: number; steps: number; curviness: number };
// An alternative route offered by the engine for the same two endpoints.
type AltPlan = PlanInfo & { coords: Coord[] };
type Props = NativeStackScreenProps<ProfileStackParams, 'RouteCreate'>;

// Old Android needs an explicit opt-in for LayoutAnimation.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Human label for the backend's deg/km curviness score (the planned route's
// actual twistiness).
function curvinessText(score: number): string {
  if (score < 30) return 'düz';
  if (score < 100) return 'kıvrımlı';
  return 'çok virajlı';
}

// Curviness preference as three tap targets. The old slider was fiddly over
// the map (gesture conflicts, thumb snapping back on Android) — riders
// literally couldn't pick a value. The backend takes any 0..1, and it selects
// among at most a handful of engine alternatives anyway, so three levels
// express the full real range.
const CURVY_OPTIONS = [
  { v: 0, icon: 'arrow-expand-horizontal', label: 'Düz' },
  { v: 0.5, icon: 'vector-curve', label: 'Dengeli' },
  { v: 1, icon: 'sine-wave', label: 'Virajlı' },
] as const;

export default function RouteCreateScreen({ navigation }: Props) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState<Coord[]>([]);
  const [snapped, setSnapped] = useState<Coord[]>([]);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  // Alternative routes for the same endpoints (only offered between exactly
  // two waypoints); drawn in gray, tap to swap with the main route.
  const [alts, setAlts] = useState<AltPlan[]>([]);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'friends' | 'public'>('private');
  const [curviness, setCurviness] = useState(0.5);
  // Detail form (name/curviness/visibility) collapses so the map stays visible
  // while placing waypoints. It springs open automatically when saving.
  const [expanded, setExpanded] = useState(false);
  const [near, setNear] = useState<{ lat: number; lon: number } | undefined>();
  const mapRef = useRef<MapView | null>(null);

  // Center on the rider's current location when available.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setNear({ lat: loc.coords.latitude, lon: loc.coords.longitude });
        mapRef.current?.animateToRegion(
          { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 },
          600,
        );
      } catch {
        // keep default region
      }
    })();
  }, []);

  function toggleExpanded(next?: boolean) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => next ?? !prev);
  }

  // Any change to the waypoints invalidates a previously computed preview.
  function setWaypoints(next: Coord[]) {
    setPoints(next);
    setSnapped([]);
    setPlan(null);
    setAlts([]);
  }

  function onMapPress(e: MapPressEvent) {
    setWaypoints([...points, e.nativeEvent.coordinate]);
  }

  // A searched place is appended as the next waypoint and the map recenters on it.
  function onPickPlace(place: Place) {
    const coord = { latitude: place.lat, longitude: place.lon };
    setWaypoints([...points, coord]);
    mapRef.current?.animateToRegion({ ...coord, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 600);
  }

  function undo() {
    setWaypoints(points.slice(0, -1));
  }

  // Reverse start/finish: A↔B swap; the auto-preview recomputes the new
  // direction (one-way roads can make it a genuinely different route).
  function reverseWaypoints() {
    if (points.length < 2) return;
    setWaypoints([...points].reverse());
  }

  function moveWaypoint(i: number, coord: Coord) {
    const next = points.slice();
    next[i] = coord;
    setWaypoints(next);
  }

  function removeWaypoint(i: number) {
    const label = i === 0 ? 'A (başlangıç)' : i === points.length - 1 ? 'B (bitiş)' : `${i + 1}. nokta`;
    Alert.alert(label, 'Bu nokta silinsin mi?', [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Sil', style: 'destructive', onPress: () => setWaypoints(points.filter((_, j) => j !== i)) },
    ]);
  }

  async function computeRoute(curvinessOverride?: number) {
    if (points.length < 2) return;
    // Guard against being wired straight to an onPress handler, which would pass
    // a gesture event here instead of a number.
    const level = typeof curvinessOverride === 'number' ? curvinessOverride : curviness;
    try {
      setPlanning(true);
      const { data } = await api.post('/api/routes/plan', {
        waypoints: points.map((p) => ({ lat: p.latitude, lon: p.longitude })),
        curviness: level,
        alternatives: true,
      });
      const toCoords = (pts: { lat: number; lon: number }[] | undefined): Coord[] =>
        (pts ?? []).map((p) => ({ latitude: p.lat, longitude: p.lon }));
      setSnapped(toCoords(data.points));
      setPlan({
        distance: data.distance,
        duration: data.duration,
        steps: (data.steps ?? []).length,
        curviness: data.curviness ?? 0,
      });
      setAlts(
        (data.alternatives ?? []).map((a: any): AltPlan => ({
          coords: toCoords(a.points),
          distance: a.distance ?? 0,
          duration: a.duration ?? 0,
          steps: (a.steps ?? []).length,
          curviness: a.curviness ?? 0,
        })),
      );
    } catch (err) {
      Alert.alert('Hesaplanamadı', errorMessage(err));
    } finally {
      setPlanning(false);
    }
  }

  // Tapping a gray alternative makes it the main route; the previous main
  // takes its place among the alternatives so the choice stays reversible.
  function selectAlt(i: number) {
    const chosen = alts[i];
    if (!chosen || !plan) return;
    const current: AltPlan = { coords: snapped, ...plan };
    setSnapped(chosen.coords);
    setPlan({ distance: chosen.distance, duration: chosen.duration, steps: chosen.steps, curviness: chosen.curviness });
    setAlts(alts.map((a, j) => (j === i ? current : a)));
  }

  async function save() {
    if (!name.trim()) {
      toggleExpanded(true);
      Alert.alert('İsim gerekli', 'Rotaya bir isim ver.');
      return;
    }
    if (points.length < 2) {
      Alert.alert('Yetersiz nokta', 'Rota için haritada en az 2 nokta seç.');
      return;
    }
    try {
      setSaving(true);
      // What you see is what you save: a computed preview (possibly a chosen
      // alternative) is stored as-is. Only without a preview do we fall back
      // to server-side snapping of the raw waypoints.
      const havePreview = snapped.length > 1;
      const geometry = havePreview ? snapped : points;
      const { data } = await api.post('/api/routes', {
        name: name.trim(),
        description: '',
        points: geometry.map((p) => ({ lat: p.latitude, lon: p.longitude })),
        snap: !havePreview,
        visibility,
        curviness,
      });
      Alert.alert('Rota kaydedildi', `${data.name} • ${data.distance.toFixed(2)} km`);
      setName('');
      setWaypoints([]);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Picking a curviness level re-previews immediately so the choice visibly
  // changes the drawn route.
  function pickCurviness(next: number) {
    setCurviness(next);
    if (points.length >= 2) void computeRoute(next);
  }

  // Auto-preview: any waypoint change (add, drag, delete, reverse) recomputes
  // the road-snapped route after a short pause — no manual "Hesapla" step.
  useEffect(() => {
    if (points.length < 2) return;
    const t = setTimeout(() => void computeRoute(), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  const line = snapped.length > 1 ? snapped : points;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={{ latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.1, longitudeDelta: 0.1 }}
        onPress={onMapPress}
        showsUserLocation
        showsMyLocationButton
      >
        {points.map((p, i) => {
          const isStart = i === 0;
          const isEnd = i === points.length - 1 && points.length > 1;
          return (
            <Marker
              key={`wp-${i}`}
              coordinate={p}
              anchor={{ x: 0.5, y: 0.5 }}
              draggable
              onDragEnd={(e) => moveWaypoint(i, e.nativeEvent.coordinate)}
              onPress={() => removeWaypoint(i)}
            >
              <View style={[styles.wpPin, isStart && styles.wpStart, isEnd && styles.wpEnd]}>
                <Text style={styles.wpText}>{isStart ? 'A' : isEnd ? 'B' : `${i + 1}`}</Text>
              </View>
            </Marker>
          );
        })}
        {/* Gray alternatives underneath; tapping one promotes it to main. */}
        {alts.map((a, i) =>
          a.coords.length > 1 ? (
            <Polyline
              key={`alt-${i}`}
              coordinates={a.coords}
              strokeColor="rgba(160,160,170,0.85)"
              strokeWidth={5}
              tappable
              onPress={() => selectAlt(i)}
              zIndex={1}
            />
          ) : null,
        )}
        {line.length > 1 && <Polyline coordinates={line} strokeColor={colors.primary} strokeWidth={4} zIndex={2} />}
      </MapView>

      <PlaceSearch onPick={onPickPlace} near={near} placeholder="Yer ara ve nokta ekle…" style={styles.search} />

      <Card style={styles.panel}>
        <Pressable style={styles.header} onPress={() => toggleExpanded()} hitSlop={8}>
          <View style={styles.headerText}>
            {planning ? (
              <Text style={styles.hint} numberOfLines={1}>
                Rota hesaplanıyor…
              </Text>
            ) : plan ? (
              <Text style={styles.stats} numberOfLines={1}>
                ≈ {plan.distance.toFixed(2)} km • {plan.duration.toFixed(0)} dk • {plan.steps} dönüş •{' '}
                {curvinessText(plan.curviness)}
              </Text>
            ) : points.length < 2 ? (
              <Text style={styles.hint} numberOfLines={1}>
                Haritaya dokunarak A ve B noktalarını ekle.
              </Text>
            ) : (
              <Text style={styles.hint} numberOfLines={1}>
                Noktaları sürükleyerek taşı, dokunarak sil.
              </Text>
            )}
            <Text style={styles.subHint} numberOfLines={1}>
              {alts.length > 0
                ? `${alts.length} alternatif var — gri çizgiye dokunarak seç`
                : `${name.trim() ? name.trim() : 'Rota adı yok'} • ${expanded ? 'Ayarları gizle' : 'Ayarlar'}`}
            </Text>
          </View>
          <MaterialCommunityIcons
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={24}
            color={colors.textMuted}
          />
        </Pressable>

        {expanded && (
          <View style={styles.form}>
            <TextField label="Rota adı" value={name} onChangeText={setName} placeholder="Sahil turu" />
            <View style={styles.curvyHeader}>
              <Text style={styles.curvyTitle}>Virajlılık tercihi</Text>
            </View>
            <View style={styles.segment}>
              {CURVY_OPTIONS.map((opt) => {
                const active = curviness === opt.v;
                return (
                  <Pressable
                    key={opt.label}
                    style={[styles.segmentBtn, active && styles.segmentActive]}
                    onPress={() => pickCurviness(opt.v)}
                  >
                    <MaterialCommunityIcons name={opt.icon} size={15} color={active ? colors.primary : colors.textMuted} />
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.curvyHint}>
              Seçim rotayı hemen yeniden hesaplar. Çok duraklı rotalarda her bölüm ayrı seçilir.
            </Text>
            <View style={styles.segment}>
              {([
                { v: 'private', icon: 'lock', label: 'Gizli' },
                { v: 'friends', icon: 'account-group', label: 'Arkadaşlar' },
                { v: 'public', icon: 'earth', label: 'Herkese' },
              ] as const).map((opt) => {
                const active = visibility === opt.v;
                return (
                  <Pressable
                    key={opt.v}
                    style={[styles.segmentBtn, active && styles.segmentActive]}
                    onPress={() => setVisibility(opt.v)}
                  >
                    <MaterialCommunityIcons name={opt.icon} size={15} color={active ? colors.text : colors.textMuted} />
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        <View style={styles.row}>
          <View style={styles.flex}>
            <Button title="Geri al" variant="ghost" icon="undo-variant" onPress={undo} />
          </View>
          <View style={{ width: spacing.sm }} />
          <View style={styles.flex}>
            <Button title="Ters Çevir" variant="ghost" icon="swap-horizontal" onPress={reverseWaypoints} />
          </View>
        </View>
        <View style={{ height: spacing.sm }} />
        <Button title={`Kaydet (${points.length})`} icon="content-save" onPress={save} loading={saving} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  search: { position: 'absolute', top: spacing.md, left: spacing.md, right: spacing.md },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  headerText: { flex: 1 },
  subHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  form: { marginBottom: spacing.xs },
  hint: { color: colors.text, fontWeight: '600' },
  curvyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  curvyTitle: { color: colors.text, fontWeight: '600', fontSize: 13 },
  curvyHint: { color: colors.textMuted, fontSize: 11, marginTop: -spacing.sm, marginBottom: spacing.sm },
  stats: { color: colors.primary, fontWeight: '700' },
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.bgAlt,
    borderRadius: radius.md,
    padding: 3,
    marginBottom: spacing.md,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  segmentActive: { backgroundColor: colors.surfaceAlt },
  segmentText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  segmentTextActive: { color: colors.text },
  wpPin: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 4,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wpStart: { backgroundColor: '#2E9E5B', borderColor: '#fff' },
  wpEnd: { backgroundColor: '#D93F33', borderColor: '#fff' },
  wpText: { color: colors.text, fontWeight: '900', fontSize: 12 },
});
