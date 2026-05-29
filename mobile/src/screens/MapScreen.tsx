import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';

import { AppTabParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type Sample = Coord & { altitude: number; speed: number; ts: string };
type Props = BottomTabScreenProps<AppTabParams, 'Ride'>;

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

  const subscription = useRef<Location.LocationSubscription | null>(null);
  const samples = useRef<Sample[]>([]);
  const lastCoord = useRef<Coord | null>(null);
  const startedAt = useRef<Date | null>(null);
  const mapRef = useRef<MapView | null>(null);

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
        mapRef.current?.animateCamera({ center: coord });
      },
    );
  }

  async function stopRecording() {
    subscription.current?.remove();
    subscription.current = null;
    setRecording(false);
    setSpeed(0);

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
        followsUserLocation={recording}
      >
        {followPath.length > 1 && (
          <Polyline coordinates={followPath} strokeColor={colors.accent} strokeWidth={5} lineDashPattern={[2, 8]} />
        )}
        {path.length > 1 && <Polyline coordinates={path} strokeColor={colors.primary} strokeWidth={6} />}
      </MapView>

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
          <Button title="Sürüşü Başlat" icon="motorbike" onPress={startRecording} loading={saving} />
        )}
      </Card>
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
  stats: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.md },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '900' },
  statUnit: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
});
