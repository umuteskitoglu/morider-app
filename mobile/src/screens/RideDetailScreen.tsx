import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { ElevationChart, ElevationProfile } from '../components/ElevationChart';
import { SpeedChart } from '../components/SpeedChart';
import { POI, poiColor, poiIcon, poiLabel } from '../lib/poi';
import { darkMapStyle } from '../lib/mapStyle';
import {
  bounds,
  buildElevationProfile,
  buildSpeedSeries,
  coloredSegments,
  computeRideStats,
  fmtDuration,
  RideStats,
  SPEED_LEGEND,
  toCoords,
  TrackPoint,
} from '../lib/rideStats';
import { api, errorMessage } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'RideDetail'>;
type Coord = { latitude: number; longitude: number };

const ISTANBUL: Region = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.1, longitudeDelta: 0.1 };

type Ride = {
  id: number;
  distance: number;
  avg_speed: number;
  elevation_gain: number;
  start_time: string | null;
  end_time: string | null;
  title: string | null;
  notes: string | null;
  motorcycle_id: number | null;
  motorcycle_name: string | null;
  max_lean_left: number | null;
  max_lean_right: number | null;
};

type Moto = { id: number; name: string };

// Quick great-circle distance (km) for the POI-near-track filter.
function distKm(a: Coord, b: Coord): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'Sürüş';
  const d = new Date(iso);
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function RideDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const [ride, setRide] = useState<Ride | null>(null);
  const [coords, setCoords] = useState<Coord[]>([]);
  const [segments, setSegments] = useState<{ color: string; coordinates: Coord[] }[]>([]);
  const [stats, setStats] = useState<RideStats | null>(null);
  const [elevation, setElevation] = useState<ElevationProfile | null>(null);
  const [speedSeries, setSpeedSeries] = useState<{ dist: number; speed: number }[]>([]);
  const [pois, setPois] = useState<POI[]>([]);
  const [loading, setLoading] = useState(true);
  const mapRef = useRef<MapView | null>(null);

  const [motos, setMotos] = useState<Moto[]>([]);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editMoto, setEditMoto] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Replay: animate a marker along the track. Index advances `mult` points per
  // tick; the speed button cycles 1×/4×/16×.
  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mult, setMult] = useState(1);
  const multRef = useRef(1);
  multRef.current = mult;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Sürüş Detayı' });
  }, [navigation]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [rideRes, trackRes] = await Promise.all([
        api.get(`/api/rides/${id}`),
        api.get(`/api/rides/${id}/track`),
      ]);
      setRide(rideRes.data);
      const points: TrackPoint[] = trackRes.data.points ?? [];
      const pts = toCoords(points);
      setCoords(pts);
      setSegments(coloredSegments(points));
      const s = computeRideStats(points);
      setStats(s);
      setElevation(buildElevationProfile(points, s));
      setSpeedSeries(buildSpeedSeries(points));

      if (pts.length > 1) {
        setTimeout(
          () =>
            mapRef.current?.fitToCoordinates(pts, {
              edgePadding: { top: 60, right: 50, bottom: 60, left: 50 },
              animated: true,
            }),
          300,
        );
      }
      // POIs near the track: fetch the track's bbox, then keep those within
      // ~500 m of the path. Best effort — markers just stay absent on failure.
      const bb = bounds(points);
      if (bb) {
        try {
          const { data } = await api.get('/api/pois', {
            params: { min_lat: bb.minLat, min_lon: bb.minLon, max_lat: bb.maxLat, max_lon: bb.maxLon },
          });
          const all: POI[] = data.pois ?? [];
          const sample = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 400)) === 0);
          setPois(
            all.filter((p) =>
              sample.some((c) => distKm(c, { latitude: p.lat, longitude: p.lon }) <= 0.5),
            ),
          );
        } catch {
          // ignore
        }
      }
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    } finally {
      setLoading(false);
    }
    try {
      const { data } = await api.get('/api/garage');
      setMotos(data.motorcycles ?? []);
    } catch {
      // ignore
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function share() {
    if (!ride || !stats) return;
    const lines = [
      `🏍️ ${fmtDate(ride.start_time)}`,
      `Mesafe: ${stats.distanceKm.toFixed(1)} km`,
      `Süre: ${fmtDuration(stats.durationMs)}`,
      `Ort. hız: ${stats.avgSpeed.toFixed(0)} km/s · Max: ${stats.maxSpeed.toFixed(0)} km/s`,
      `Yükseliş: ${Math.round(stats.ascent)} m`,
      '— Morider',
    ];
    try {
      await Share.share({ message: lines.join('\n') });
    } catch {
      // user cancelled / unavailable
    }
  }

  function stopReplay() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
  }

  function toggleReplay() {
    if (coords.length < 2) return;
    if (playing) {
      stopReplay();
      return;
    }
    let i = replayIdx >= coords.length - 1 ? 0 : replayIdx;
    setReplayIdx(i);
    setPlaying(true);
    timer.current = setInterval(() => {
      i = Math.min(i + multRef.current, coords.length - 1);
      setReplayIdx(i);
      mapRef.current?.animateCamera({ center: coords[i] }, { duration: 90 });
      if (i >= coords.length - 1) stopReplay();
    }, 90);
  }

  // Restart the interval when the speed multiplier changes mid-playback.
  function cycleMult() {
    const next = mult === 1 ? 4 : mult === 4 ? 16 : 1;
    setMult(next);
  }

  // Tear the timer down on unmount / blur.
  useFocusEffect(
    useCallback(() => {
      return () => stopReplay();
    }, []),
  );

  function openEdit() {
    setEditTitle(ride?.title ?? '');
    setEditNotes(ride?.notes ?? '');
    setEditMoto(ride?.motorcycle_id ?? null);
    setEditing(true);
  }

  async function saveEdit() {
    try {
      setSaving(true);
      const { data } = await api.patch(`/api/rides/${id}`, {
        title: editTitle.trim() || null,
        notes: editNotes.trim() || null,
        motorcycle_id: editMoto,
      });
      const moto = motos.find((m) => m.id === editMoto);
      setRide({ ...data, motorcycle_name: moto ? moto.name : null });
      setEditing(false);
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    Alert.alert('Sürüşü sil', 'Bu sürüş ve kaydı kalıcı olarak silinsin mi?', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            setDeleting(true);
            await api.delete(`/api/rides/${id}`);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  }

  const initialRegion: Region = coords[0]
    ? { ...coords[0], latitudeDelta: 0.05, longitudeDelta: 0.05 }
    : ISTANBUL;

  if (loading && !ride) {
    return (
      <View style={[styles.container, styles.loadingWrap]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const start = coords[0];
  const end = coords[coords.length - 1];

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} initialRegion={initialRegion} customMapStyle={darkMapStyle}>
        {segments.map((seg, i) => (
          <Polyline key={`seg-${i}`} coordinates={seg.coordinates} strokeColor={seg.color} strokeWidth={5} />
        ))}
        {start && (
          <Marker coordinate={start} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={[styles.endDot, { backgroundColor: colors.success }]} />
          </Marker>
        )}
        {end && coords.length > 1 && (
          <Marker coordinate={end} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={[styles.endDot, { backgroundColor: colors.danger }]} />
          </Marker>
        )}
        {pois.map((p) => (
          <Marker
            key={`poi-${p.id}`}
            coordinate={{ latitude: p.lat, longitude: p.lon }}
            title={p.name}
            description={poiLabel(p.category)}
            tracksViewChanges={false}
          >
            <View style={[styles.poiPin, { borderColor: poiColor(p.category) }]}>
              <MaterialCommunityIcons name={poiIcon(p.category) as any} size={15} color={poiColor(p.category)} />
            </View>
          </Marker>
        ))}
        {(playing || replayIdx > 0) && coords[replayIdx] && (
          <Marker coordinate={coords[replayIdx]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.replayDot}>
              <MaterialCommunityIcons name="motorbike" size={16} color="#fff" />
            </View>
          </Marker>
        )}
      </MapView>

      {coords.length > 1 && (
        <View style={styles.replayBar}>
          <Pressable style={styles.replayBtn} onPress={toggleReplay}>
            <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={22} color={colors.text} />
          </Pressable>
          <Pressable style={styles.multBtn} onPress={cycleMult}>
            <Text style={styles.multText}>{mult}×</Text>
          </Pressable>
        </View>
      )}

      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>
        <Card>
          <View style={styles.headRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.date}>{ride?.title || fmtDate(ride?.start_time ?? null)}</Text>
              {ride?.title ? <Text style={styles.muted}>{fmtDate(ride?.start_time ?? null)}</Text> : null}
            </View>
            <Text style={styles.distance}>{(stats?.distanceKm ?? ride?.distance ?? 0).toFixed(2)} km</Text>
          </View>
          {ride?.motorcycle_name ? (
            <View style={styles.poiRow}>
              <MaterialCommunityIcons name="motorbike" size={15} color={colors.textMuted} />
              <Text style={styles.muted}>{ride.motorcycle_name}</Text>
            </View>
          ) : null}
          {ride?.notes ? <Text style={styles.notes}>{ride.notes}</Text> : null}

          {/* speed legend */}
          <View style={styles.legend}>
            {SPEED_LEGEND.map((l) => (
              <View key={l.label} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: l.color }]} />
                <Text style={styles.legendText}>{l.label}</Text>
              </View>
            ))}
            <Text style={styles.legendUnit}>km/s</Text>
          </View>

          {stats && (
            <View style={styles.grid}>
              <StatCell icon="timer-outline" value={fmtDuration(stats.durationMs)} label="Süre" />
              <StatCell icon="motorbike" value={fmtDuration(stats.movingMs)} label="Hareket" />
              <StatCell icon="speedometer-medium" value={`${stats.avgSpeed.toFixed(0)}`} label="Ort. km/s" />
              <StatCell icon="speedometer" value={`${stats.maxSpeed.toFixed(0)}`} label="Max km/s" />
              <StatCell icon="arrow-top-right" value={`${Math.round(stats.ascent)}`} label="Yükseliş m" />
              <StatCell icon="arrow-bottom-right" value={`${Math.round(stats.descent)}`} label="İniş m" />
            </View>
          )}

          {(ride?.max_lean_left != null || ride?.max_lean_right != null) && (
            <View style={styles.leanRow}>
              <MaterialCommunityIcons name="angle-acute" size={18} color={colors.primary} />
              <Text style={styles.leanText}>
                Yatış · Sol {Math.round(ride?.max_lean_left ?? 0)}° · Sağ {Math.round(ride?.max_lean_right ?? 0)}°
              </Text>
            </View>
          )}

          {elevation && <ElevationChart profile={elevation} />}
          {speedSeries.length > 1 && <SpeedChart series={speedSeries} />}

          {pois.length > 0 && (
            <View style={styles.poiRow}>
              <MaterialCommunityIcons name="map-marker-star-outline" size={15} color={colors.textMuted} />
              <Text style={styles.muted}>{pois.length} mola noktasından geçtin</Text>
            </View>
          )}

          <View style={{ height: spacing.md }} />
          <Button title="Paylaş" variant="ghost" icon="share-variant" onPress={share} />
          <View style={{ height: spacing.sm }} />
          <Button title="Düzenle" variant="ghost" icon="pencil-outline" onPress={openEdit} />
          <View style={{ height: spacing.sm }} />
          <Button title="Sürüşü Sil" variant="ghost" icon="trash-can-outline" onPress={confirmDelete} loading={deleting} />
        </Card>
      </ScrollView>

      <Modal visible={editing} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setEditing(false)}>
        <Pressable style={styles.backdrop} onPress={() => setEditing(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Text style={styles.modalTitle}>Sürüşü Düzenle</Text>
            <TextField label="Başlık" value={editTitle} onChangeText={setEditTitle} placeholder="Sabah turu" />
            <TextField label="Not" value={editNotes} onChangeText={setEditNotes} placeholder="Hava güzeldi…" multiline />
            <Text style={styles.fieldLabel}>Motor</Text>
            <View style={styles.motoRow}>
              <Pressable
                style={[styles.motoPill, editMoto == null && styles.motoPillActive]}
                onPress={() => setEditMoto(null)}
              >
                <Text style={[styles.motoText, editMoto == null && { color: colors.text }]}>Yok</Text>
              </Pressable>
              {motos.map((m) => (
                <Pressable
                  key={m.id}
                  style={[styles.motoPill, editMoto === m.id && styles.motoPillActive]}
                  onPress={() => setEditMoto(m.id)}
                >
                  <Text style={[styles.motoText, editMoto === m.id && { color: colors.text }]}>{m.name}</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ height: spacing.md }} />
            <Button title="Kaydet" icon="check" onPress={saveEdit} loading={saving} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function StatCell({ icon, value, label }: { icon: any; value: string; label: string }) {
  return (
    <View style={styles.cell}>
      <MaterialCommunityIcons name={icon} size={20} color={colors.primary} />
      <Text style={styles.cellValue}>{value}</Text>
      <Text style={styles.cellLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  loadingWrap: { alignItems: 'center', justifyContent: 'center' },
  map: { height: '42%' },
  sheet: { flex: 1 },
  sheetContent: { padding: spacing.md, paddingBottom: spacing.xl },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  date: { color: colors.text, fontSize: 16, fontWeight: '800' },
  distance: { color: colors.primary, fontSize: 24, fontWeight: '900' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  legendUnit: { color: colors.textMuted, fontSize: 11, marginLeft: 'auto' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.md },
  cell: { width: '33.33%', alignItems: 'center', paddingVertical: spacing.sm, gap: 2 },
  cellValue: { color: colors.text, fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'] },
  cellLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  poiRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm },
  muted: { color: colors.textMuted },
  notes: { color: colors.text, marginTop: spacing.sm, lineHeight: 20 },
  leanRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  leanText: { color: colors.text, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: spacing.md },
  fieldLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs },
  motoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  motoPill: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgAlt },
  motoPillActive: { borderColor: colors.primary, backgroundColor: 'rgba(255,106,26,0.12)' },
  motoText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  endDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
    ...shadow.card,
  },
  replayDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.glow,
  },
  replayBar: { position: 'absolute', left: spacing.md, top: '42%', marginTop: -54, flexDirection: 'row', gap: spacing.sm },
  replayBtn: {
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
  multBtn: {
    height: 46,
    paddingHorizontal: spacing.md,
    borderRadius: 23,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  multText: { color: colors.text, fontWeight: '800', fontSize: 15 },
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
});
