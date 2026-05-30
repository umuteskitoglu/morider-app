import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { RoutesStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, apiBaseURL, errorMessage, TOKEN_KEY } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type LiveMarker = { userId: number; name: string; lat: number; lon: number; speed: number; ts: number };
type Participant = { id: number; name: string };
type Props = NativeStackScreenProps<RoutesStackParams, 'GroupRide'>;

const INITIAL_REGION: Region = {
  latitude: 41.0082,
  longitude: 28.9784,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// Distinct marker colors assigned per participant (own dot is the native blue).
const MARKER_COLORS = ['#FF5A1F', '#2FD27A', '#FFB020', '#4C8AFF', '#C264FF', '#FF5E8A'];

export default function GroupRideScreen({ route, navigation }: Props) {
  const { code } = route.params;
  const { user } = useAuth();

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [routePath, setRoutePath] = useState<Coord[]>([]);
  const [hostId, setHostId] = useState<number | null>(null);
  const [positions, setPositions] = useState<Record<number, LiveMarker>>({});
  const [connected, setConnected] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const locSub = useRef<Location.LocationSubscription | null>(null);
  const mapRef = useRef<MapView | null>(null);
  const leaving = useRef(false);

  const isHost = hostId != null && user?.id === hostId;

  useLayoutEffect(() => {
    navigation.setOptions({ title: `Grup · ${code}` });
  }, [navigation, code]);

  // Color is stable per participant id (index in the sorted participant list).
  const colorFor = useCallback(
    (userId: number) => {
      const ids = participants.map((p) => p.id).sort((a, b) => a - b);
      const idx = ids.indexOf(userId);
      return MARKER_COLORS[(idx < 0 ? userId : idx) % MARKER_COLORS.length];
    },
    [participants],
  );

  const loadSession = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/sessions/${code}`);
      setParticipants(data.participants ?? []);
      setHostId(data.host_id ?? null);
      const pts: Coord[] = (data.route_points ?? []).map((p: { lat: number; lon: number }) => ({
        latitude: p.lat,
        longitude: p.lon,
      }));
      setRoutePath(pts);
      if (pts.length > 1) {
        setTimeout(
          () => mapRef.current?.fitToCoordinates(pts, { edgePadding: { top: 100, right: 60, bottom: 240, left: 60 }, animated: true }),
          400,
        );
      }
    } catch (err) {
      Alert.alert('Oturum yüklenemedi', errorMessage(err));
    }
  }, [code]);

  // Open the live WebSocket and start streaming our own GPS.
  const connect = useCallback(async () => {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const wsUrl = `${apiBaseURL().replace(/^http/, 'ws')}/api/sessions/${code}/ws?token=${token}`;
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (e) => {
      try {
        const m: LiveMarker = JSON.parse(e.data);
        setPositions((prev) => ({ ...prev, [m.userId]: m }));
      } catch {
        // ignore malformed frames
      }
    };

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('İzin gerekli', 'Canlı konum paylaşımı için konum izni vermelisiniz.');
      return;
    }
    locSub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 3000 },
      (loc) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              lat: loc.coords.latitude,
              lon: loc.coords.longitude,
              speed: Math.max(0, (loc.coords.speed ?? 0) * 3.6),
            }),
          );
        }
      },
    );
  }, [code]);

  useEffect(() => {
    loadSession();
    connect();
    return () => {
      locSub.current?.remove();
      ws.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function teardown() {
    locSub.current?.remove();
    locSub.current = null;
    ws.current?.close();
    ws.current = null;
  }

  async function shareCode() {
    try {
      await Share.share({ message: `Morider grup sürüşüme katıl! Kod: ${code}` });
    } catch {
      // ignore
    }
  }

  async function leave() {
    if (leaving.current) return;
    leaving.current = true;
    teardown();
    try {
      await api.post(`/api/sessions/${code}/leave`);
    } catch {
      // best effort
    }
    navigation.goBack();
  }

  function confirmEnd() {
    Alert.alert('Grup sürüşünü bitir', 'Oturum tüm katılımcılar için sonlanacak. Emin misin?', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Bitir',
        style: 'destructive',
        onPress: async () => {
          if (leaving.current) return;
          leaving.current = true;
          teardown();
          try {
            await api.post(`/api/sessions/${code}/end`);
          } catch {
            // best effort
          }
          navigation.goBack();
        },
      },
    ]);
  }

  // Other participants' live markers (our own position shows as the blue dot).
  const others = Object.values(positions).filter((m) => m.userId !== user?.id);
  const liveCount = new Set([...others.map((m) => m.userId), ...(user ? [user.id] : [])]).size;

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={INITIAL_REGION} showsUserLocation showsMyLocationButton={false}>
        {routePath.length > 1 && (
          <Polyline coordinates={routePath} strokeColor={colors.accent} strokeWidth={5} lineDashPattern={[2, 8]} />
        )}
        {others.map((m) => (
          <Marker
            key={m.userId}
            coordinate={{ latitude: m.lat, longitude: m.lon }}
            title={m.name}
            description={`${m.speed.toFixed(0)} km/s`}
            pinColor={colorFor(m.userId)}
          >
            <View style={[styles.marker, { backgroundColor: colorFor(m.userId) }]}>
              <Text style={styles.markerText}>{m.name?.charAt(0).toUpperCase() ?? '?'}</Text>
            </View>
          </Marker>
        ))}
      </MapView>

      {/* Status badge */}
      <View style={styles.badgeWrap} pointerEvents="none">
        <View style={[styles.badge, connected ? styles.badgeLive : styles.badgeIdle]}>
          <View style={[styles.dot, { backgroundColor: connected ? colors.success : colors.textMuted }]} />
          <Text style={styles.badgeText}>{connected ? 'CANLI' : 'BAĞLANIYOR…'}</Text>
        </View>
      </View>

      <Card style={styles.panel}>
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.codeLabel}>OTURUM KODU</Text>
            <Text style={styles.code}>{code}</Text>
          </View>
          <View style={styles.countWrap}>
            <MaterialCommunityIcons name="account-group" size={18} color={colors.primary} />
            <Text style={styles.count}>{liveCount}/{participants.length}</Text>
          </View>
          <Pressable style={styles.shareBtn} onPress={shareCode} hitSlop={8}>
            <MaterialCommunityIcons name="share-variant" size={20} color={colors.text} />
          </Pressable>
        </View>
        {isHost ? (
          <Button title="Grup Sürüşünü Bitir" variant="danger" icon="stop-circle" onPress={confirmEnd} />
        ) : (
          <Button title="Ayrıl" variant="ghost" icon="exit-run" onPress={leave} />
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  marker: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  markerText: { color: '#fff', fontWeight: '900', fontSize: 14 },
  badgeWrap: { position: 'absolute', top: spacing.lg, left: 0, right: 0, alignItems: 'center' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    ...shadow.card,
  },
  badgeLive: { backgroundColor: 'rgba(47,210,122,0.18)', borderWidth: 1, borderColor: colors.success },
  badgeIdle: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  badgeText: { color: colors.text, fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg, gap: spacing.md },
  panelHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  codeLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  code: { color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: 3 },
  countWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' },
  count: { color: colors.text, fontWeight: '800' },
  shareBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
