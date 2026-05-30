import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, apiBaseURL, errorMessage, TOKEN_KEY } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type LiveMarker = { userId: number; name: string; lat: number; lon: number; speed: number; ts: number };
type Participant = { id: number; name: string };
type Props = NativeStackScreenProps<RideStackParams, 'GroupRide'>;

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
  const [showParticipants, setShowParticipants] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const locSub = useRef<Location.LocationSubscription | null>(null);
  const mapRef = useRef<MapView | null>(null);
  const leaving = useRef(false);
  const hasRoute = useRef(false); // when a route is set, fit to it instead of the user
  const centered = useRef(false); // auto-center on the user only once
  const closed = useRef(false); // screen torn down → stop reconnecting
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

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

  const loadSession = useCallback(async (fit = true) => {
    try {
      const { data } = await api.get(`/api/sessions/${code}`);
      // Don't sit on a dead session: if it ended (or we're gone), bail out.
      if (data.status && data.status !== 'active') {
        closed.current = true;
        Alert.alert('Grup sürüşü bitti', 'Bu sürüş artık aktif değil.');
        navigation.goBack();
        return;
      }
      setParticipants(data.participants ?? []);
      setHostId(data.host_id ?? null);
      const pts: Coord[] = (data.route_points ?? []).map((p: { lat: number; lon: number }) => ({
        latitude: p.lat,
        longitude: p.lon,
      }));
      setRoutePath(pts);
      hasRoute.current = pts.length > 1;
      if (fit && pts.length > 1) {
        setTimeout(
          () => mapRef.current?.fitToCoordinates(pts, { edgePadding: { top: 100, right: 60, bottom: 240, left: 60 }, animated: true }),
          400,
        );
      }
    } catch (err) {
      Alert.alert('Oturum yüklenemedi', errorMessage(err));
    }
  }, [code]);

  // Open the live WebSocket, retrying with backoff if it drops (e.g. the screen
  // was backgrounded or the network blipped) until the screen is torn down.
  const connectWS = useCallback(async () => {
    if (closed.current) return;
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const wsUrl = `${apiBaseURL().replace(/^http/, 'ws')}/api/sessions/${code}/ws?token=${token}`;
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => {
      reconnectAttempts.current = 0;
      setConnected(true);
    };
    socket.onclose = () => {
      setConnected(false);
      if (closed.current) return;
      reconnectAttempts.current += 1;
      if (reconnectAttempts.current > 10) {
        Alert.alert('Bağlantı kesildi', 'Grup sürüşüne yeniden bağlanılamadı.');
        return;
      }
      const delay = Math.min(1000 * reconnectAttempts.current, 5000);
      reconnectTimer.current = setTimeout(() => reconnect(), delay);
    };
    socket.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        // Control frames carry a "type"; position frames do not.
        if (raw.type === 'kick' || raw.type === 'ban') {
          if (raw.user_id === user?.id) {
            teardown();
            Alert.alert(
              raw.type === 'ban' ? 'Banlandın' : 'Sürüşten çıkarıldın',
              'Host seni grup sürüşünden çıkardı.',
            );
            navigation.goBack();
          } else {
            setPositions((prev) => {
              const next = { ...prev };
              delete next[raw.user_id];
              return next;
            });
            setParticipants((prev) => prev.filter((p) => p.id !== raw.user_id));
          }
          return;
        }
        if (raw.type === 'host') {
          setHostId(raw.host_id);
          return;
        }
        if (raw.type === 'left') {
          setPositions((prev) => {
            const next = { ...prev };
            delete next[raw.user_id];
            return next;
          });
          setParticipants((prev) => prev.filter((p) => p.id !== raw.user_id));
          return;
        }
        if (raw.type === 'ended') {
          if (leaving.current) return; // we ended/left it ourselves
          teardown();
          Alert.alert('Grup sürüşü bitti', 'Host sürüşü sonlandırdı.');
          navigation.goBack();
          return;
        }
        // Position frame: backend sends snake_case (user_id) → camelCase marker.
        if (raw.user_id == null) return;
        const m: LiveMarker = {
          userId: raw.user_id,
          name: raw.name,
          lat: raw.lat,
          lon: raw.lon,
          speed: raw.speed,
          ts: raw.ts,
        };
        setPositions((prev) => ({ ...prev, [m.userId]: m }));
      } catch {
        // ignore malformed frames
      }
    };
  }, [code]);

  // Before reconnecting, make sure the session is still joinable. A permanent
  // failure (ended session, or we were kicked/banned while disconnected) returns
  // 200-not-active / not-a-participant — stop retrying and leave instead of
  // hammering the server. A network error just retries the socket.
  async function reconnect() {
    if (closed.current) return;
    try {
      const { data } = await api.get(`/api/sessions/${code}`);
      const stillIn = (data.participants ?? []).some((p: Participant) => p.id === user?.id);
      if (data.status !== 'active' || !stillIn) {
        closed.current = true;
        Alert.alert('Grup sürüşü', 'Bu sürüşe artık bağlı değilsin.');
        navigation.goBack();
        return;
      }
    } catch {
      // couldn't verify (likely transient/offline) → just try the socket again
    }
    connectWS();
  }

  // Ask for location permission once and stream our own GPS over whatever socket
  // is currently open (ws.current is swapped on reconnect).
  const startLocationWatch = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('İzin gerekli', 'Canlı konum paylaşımı için konum izni vermelisiniz.');
      return;
    }

    if (closed.current) return;

    // Snap the map onto the rider straight away (like the solo ride screen),
    // unless a target route is set — then loadSession fits to the route.
    centerOnUser();

    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 3000 },
      (loc) => {
        const coord = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        if (!centered.current && !hasRoute.current) {
          centered.current = true;
          mapRef.current?.animateToRegion({ ...coord, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 600);
        }
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(
            JSON.stringify({
              lat: coord.latitude,
              lon: coord.longitude,
              speed: Math.max(0, (loc.coords.speed ?? 0) * 3.6),
            }),
          );
        }
      },
    );
    // If the screen was torn down while we awaited, drop the fresh subscription
    // so the GPS watch doesn't leak past the screen's lifetime.
    if (closed.current) {
      sub.remove();
      return;
    }
    locSub.current = sub;
  }, []);

  // Center the map on the rider's current position (no-op if a route is loaded).
  async function centerOnUser() {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (hasRoute.current) return;
      centered.current = true;
      mapRef.current?.animateToRegion(
        { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 },
        600,
      );
    } catch {
      // ignore — keep default region
    }
  }

  useEffect(() => {
    // Reset per-ride state so switching sessions (code change) starts clean.
    closed.current = false;
    centered.current = false;
    reconnectAttempts.current = 0;
    setPositions({});
    loadSession();
    connectWS();
    startLocationWatch();
    return () => {
      closed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      locSub.current?.remove();
      locSub.current = null;
      detachSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Close the socket after detaching its handlers, so a stale onclose from a
  // socket we're discarding can't schedule a reconnect to the old session.
  function detachSocket() {
    const s = ws.current;
    if (s) {
      s.onopen = null;
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      s.close();
    }
    ws.current = null;
  }

  function teardown() {
    closed.current = true;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    locSub.current?.remove();
    locSub.current = null;
    detachSocket();
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

  // Close the sheet and zoom the map onto a participant's live position.
  function focusUser(id: number) {
    const m = positions[id];
    if (!m) return;
    setShowParticipants(false);
    mapRef.current?.animateToRegion({ latitude: m.lat, longitude: m.lon, latitudeDelta: 0.004, longitudeDelta: 0.004 }, 600);
  }

  // Host-only moderation. State updates arrive for everyone via control frames.
  async function moderate(action: 'kick' | 'ban' | 'transfer', id: number) {
    try {
      await api.post(`/api/sessions/${code}/${action}`, { user_id: id });
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    }
  }

  function hostMenu(id: number, name: string) {
    const opts: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (positions[id]) opts.push({ text: 'Haritada odakla', onPress: () => focusUser(id) });
    opts.push({
      text: 'Host yap (devret)',
      onPress: () =>
        Alert.alert('Host devret', `${name} yeni host olsun mu?`, [
          { text: 'Vazgeç', style: 'cancel' },
          { text: 'Devret', onPress: () => moderate('transfer', id) },
        ]),
    });
    opts.push({
      text: 'Sürüşten at',
      style: 'destructive',
      onPress: () =>
        Alert.alert('Sürüşten at', `${name} atılsın mı? (Tekrar katılabilir)`, [
          { text: 'Vazgeç', style: 'cancel' },
          { text: 'At', style: 'destructive', onPress: () => moderate('kick', id) },
        ]),
    });
    opts.push({
      text: 'Banla',
      style: 'destructive',
      onPress: () =>
        Alert.alert('Banla', `${name} banlansın mı? Bu sürüşe tekrar katılamaz.`, [
          { text: 'Vazgeç', style: 'cancel' },
          { text: 'Banla', style: 'destructive', onPress: () => moderate('ban', id) },
        ]),
    });
    opts.push({ text: 'Vazgeç', style: 'cancel' });
    Alert.alert(name, 'Katılımcı işlemi', opts);
  }

  // Other participants' live markers (our own position shows as the blue dot).
  const others = Object.values(positions).filter((m) => m.userId !== user?.id);
  const liveCount = new Set([...others.map((m) => m.userId), ...(user ? [user.id] : [])]).size;

  // Roster for the participants sheet: everyone who joined (from the API) merged
  // with anyone currently streaming a position (covers a stale joined list).
  type Roster = { id: number; name: string; live: boolean };
  const roster: Roster[] = (() => {
    const byId = new Map<number, Roster>();
    for (const p of participants) {
      byId.set(p.id, { id: p.id, name: p.name, live: !!positions[p.id] || (p.id === user?.id && connected) });
    }
    for (const m of Object.values(positions)) {
      if (!byId.has(m.userId)) byId.set(m.userId, { id: m.userId, name: m.name, live: true });
    }
    if (user && !byId.has(user.id)) byId.set(user.id, { id: user.id, name: user.name, live: connected });
    return Array.from(byId.values());
  })();
  const liveTotal = roster.filter((r) => r.live).length;

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
          <Pressable
            style={styles.countWrap}
            onPress={() => {
              loadSession(false); // refresh the roster without re-fitting the map
              setShowParticipants(true);
            }}
            hitSlop={8}
          >
            <MaterialCommunityIcons name="account-group" size={18} color={colors.primary} />
            <Text style={styles.count}>{liveCount}/{roster.length}</Text>
            <MaterialCommunityIcons name="chevron-up" size={16} color={colors.textMuted} />
          </Pressable>
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

      <Modal visible={showParticipants} animationType="slide" transparent onRequestClose={() => setShowParticipants(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowParticipants(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Katılımcılar</Text>
              <Text style={styles.sheetSub}>{liveTotal} canlı · {roster.length} toplam</Text>
            </View>
            <ScrollView style={styles.sheetList}>
              {roster.map((r) => {
                const canFocus = !!positions[r.id];
                return (
                  <Pressable
                    key={r.id}
                    style={({ pressed }) => [styles.pRow, pressed && canFocus && styles.pRowPressed]}
                    onPress={() => focusUser(r.id)}
                    disabled={!canFocus}
                  >
                    <View style={[styles.pDot, { backgroundColor: r.id === user?.id ? colors.primary : colorFor(r.id) }]}>
                      <Text style={styles.pDotText}>{r.name?.charAt(0).toUpperCase() ?? '?'}</Text>
                    </View>
                    <View style={styles.pInfo}>
                      <Text style={styles.pName}>
                        {r.name}
                        {r.id === user?.id ? ' (sen)' : ''}
                      </Text>
                      {r.id === hostId ? <Text style={styles.pHost}>Host</Text> : null}
                    </View>
                    <View style={[styles.pStatus, r.live ? styles.pStatusLive : styles.pStatusIdle]}>
                      <View style={[styles.pStatusDot, { backgroundColor: r.live ? colors.success : colors.textMuted }]} />
                      <Text style={styles.pStatusText}>{r.live ? 'Canlı' : 'Bekleniyor'}</Text>
                    </View>
                    {isHost && r.id !== user?.id ? (
                      <Pressable hitSlop={8} onPress={() => hostMenu(r.id, r.name)} style={styles.pMenuBtn}>
                        <MaterialCommunityIcons name="dots-vertical" size={20} color={colors.text} />
                      </Pressable>
                    ) : canFocus ? (
                      <MaterialCommunityIcons name="crosshairs-gps" size={18} color={colors.textMuted} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
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
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    paddingTop: spacing.sm,
    maxHeight: '70%',
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  sheetHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.sm },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  sheetSub: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  sheetList: { flexGrow: 0 },
  pRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border },
  pRowPressed: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm },
  pMenuBtn: { padding: spacing.xs },
  pDot: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  pDotText: { color: '#fff', fontWeight: '900' },
  pInfo: { flex: 1 },
  pName: { color: colors.text, fontWeight: '800' },
  pHost: { color: colors.primary, fontSize: 11, fontWeight: '700', marginTop: 1 },
  pStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1 },
  pStatusLive: { backgroundColor: 'rgba(47,210,122,0.12)', borderColor: colors.success },
  pStatusIdle: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  pStatusDot: { width: 7, height: 7, borderRadius: 4 },
  pStatusText: { color: colors.text, fontSize: 11, fontWeight: '700' },
});
