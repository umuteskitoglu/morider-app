import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Modal, Pressable, ScrollView, Share, StyleSheet, Text, Vibration, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import QRCode from 'react-native-qrcode-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { CrashCountdown } from '../components/CrashCountdown';
import { NavBanner } from '../components/NavBanner';
import { darkMapStyle } from '../lib/mapStyle';
import { useCrashDetection } from '../lib/crashDetection';
import { composeEmergencySMS, getEmergencyContact } from '../lib/emergency';
import { flushSOSQueue, newSosId, raiseSOS } from '../lib/sos';
import {
  advanceStep,
  fetchRouteSteps,
  distanceM,
  LatLon,
  maybeSpeak,
  NavStep,
  newRerouteState,
  offRouteTick,
  rerouteFromPosition,
  speakRerouted,
  SpokenState,
  stopSpeaking,
} from '../lib/navigation';
import { useAuth } from '../store/auth';
import { useGroupVoice } from '../lib/voice';
import {
  CohesionResult,
  CohesionRider,
  evaluateCohesion,
  fmtGap,
  RiderCohesion,
} from '../lib/groupCohesion';
import { setLastRideSummary } from '../lib/rideStore';
import { useRideRecorder } from '../lib/useRideRecorder';
import { api, apiBaseURL, errorMessage, TOKEN_KEY } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
// `ts` is the server's clock (UnixMilli); `rxAt` is ours. Staleness is measured
// against rxAt so a phone with a skewed clock doesn't grey out live riders — or
// worse, show a dead rider as live.
type LiveMarker = { userId: number; name: string; lat: number; lon: number; speed: number; ts: number; rxAt: number };

// A rider whose last frame is older than this is no longer where the map says.
const FRESH_MS = 15_000;
const STALE_MS = 60_000;

function markerAge(m: LiveMarker, now: number): 'live' | 'lagging' | 'lost' {
  const age = now - m.rxAt;
  if (age < FRESH_MS) return 'live';
  if (age < STALE_MS) return 'lagging';
  return 'lost';
}

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'az önce';
  if (m < 60) return `${m} dk önce`;
  return `${Math.floor(m / 60)} sa önce`;
}
type Participant = { id: number; name: string };
type Props = NativeStackScreenProps<RideStackParams, 'GroupRide'>;

const INITIAL_REGION: Region = {
  latitude: 41.0082,
  longitude: 28.9784,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// Distinct marker colors assigned per participant (own dot is the native blue).
const MARKER_COLORS = ['#FF6A1A', '#35E0C8', '#FFB020', '#4C8AFF', '#C264FF', '#FF5E8A'];

// Google-Maps navigation route colors, matching MapScreen: a bright blue fill
// with a darker blue casing/outline drawn underneath it.
const navRouteFill = '#4E9BFF';
const navRouteCasing = '#1A6CD4';

// Ink used on top of the saturated accent fills (success / primary / danger).
// Those fills are too light for white text to clear WCAG AA.
const ON_ACCENT = '#0B0D10';

export default function GroupRideScreen({ route, navigation }: Props) {
  const { code } = route.params;
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [routePath, setRoutePath] = useState<Coord[]>([]);
  const [hostId, setHostId] = useState<number | null>(null);
  const [positions, setPositions] = useState<Record<number, LiveMarker>>({});
  const [connected, setConnected] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [crashAlarm, setCrashAlarm] = useState(false);
  const [cohesion, setCohesion] = useState<CohesionResult>({
    centre: null,
    entries: [],
    gapKm: {},
    state: {},
    dropped: [],
    liveCount: 0,
  });

  // Turn-by-turn for the session's route (banner only; the map stays free so
  // the rider can keep an eye on the whole group).
  const [navStep, setNavStep] = useState<NavStep | null>(null);
  const [navDist, setNavDist] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const navSteps = useRef<NavStep[] | null>(null);
  const navIdx = useRef(0);
  const spoken = useRef<SpokenState>({ idx: -1, far: false, near: false });
  const voiceRef = useRef(true);
  voiceRef.current = voiceOn;
  // Session route geometry for off-route detection (refs because the location
  // callback outlives the render that created it).
  const routePointsRef = useRef<LatLon[]>([]);
  const reroute = useRef(newRerouteState());

  // Chase cam follows the rider until they pan the map by hand; a "recenter"
  // button resumes it. Without this the map snapped back on every GPS fix, so
  // looking at the rest of the group — the whole point of this screen — was
  // impossible while moving, and focusUser() below never worked at all.
  const [followCam, setFollowCam] = useState(true);
  const followCamRef = useRef(true);
  followCamRef.current = followCam;

  // Ticker that ages the markers even when no frames arrive: without it a
  // rider whose phone died keeps rendering as freshly live forever.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const ws = useRef<WebSocket | null>(null);
  const mapRef = useRef<MapView | null>(null);
  const leaving = useRef(false);
  const hasRoute = useRef(false); // when a route is set, fit to it instead of the user
  const centered = useRef(false); // auto-center on the user only once
  // Chase-cam pitch/zoom set once at the first fix; later fixes only pan/rotate
  // so the map doesn't jolt "up" on every position update.
  const camPrimed = useRef(false);
  const closed = useRef(false); // screen torn down → stop reconnecting
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const lastCoord = useRef<{ lat: number; lon: number; speed: number } | null>(null);
  const lastMovedAt = useRef(0);
  // Previous cohesion tick, fed back in so the state machine stays pure.
  const prevGap = useRef<Record<number, number>>({});
  const prevCohesion = useRef<Record<number, RiderCohesion>>({});
  // Who we have already announced, so the alert fires on the transition rather
  // than every five seconds for the rest of the ride.
  const announced = useRef<Set<number>>(new Set());
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);

  // Group-specific work on each fix: keep the map with the rider, advance the
  // shared route's turn-by-turn, and push the position to the session.
  const rec = useRideRecorder(({ lat, lon, speed, heading }) => {
    lastCoord.current = { lat, lon, speed };
    centered.current = true;
    updateNavigation({ lat, lon });
    // Suspended while the rider has panned the map by hand (followCam off), so
    // checking on the group isn't undone by the next fix.
    if (followCamRef.current) {
      const center = { latitude: lat, longitude: lon };
      if (!camPrimed.current) {
        camPrimed.current = true;
        mapRef.current?.animateCamera(
          { center, pitch: 55, zoom: 17.5, ...(heading >= 0 ? { heading } : {}) },
          { duration: 700 },
        );
      } else {
        mapRef.current?.animateCamera({ center, ...(heading >= 0 ? { heading } : {}) }, { duration: 700 });
      }
    }
    sendPosition();
  });

  const isHost = hostId != null && user?.id === hostId;

  // Always-on group voice chat (LiveKit). Opt-in per rider; the mic stays live
  // until they leave voice or the screen unmounts.
  const voice = useGroupVoice(code);
  const speakingSet = new Set(voice.speaking);

  function toggleVoice() {
    if (voice.status === 'off' || voice.status === 'error') {
      voice.join().catch(() => {});
    } else {
      voice.leave().catch(() => {});
    }
  }

  // One glanceable line of status so the rider always knows where voice stands:
  // connecting / live / muted / actively transmitting / failed.
  const selfLive = voice.status === 'connected' && !voice.muted && voice.selfSpeaking;
  const voiceLabel = (() => {
    switch (voice.status) {
      case 'connecting':
        return 'Bağlanıyor…';
      case 'error':
        return 'Bağlanamadı, dokun';
      case 'connected':
        if (voice.muted) return 'Mikrofon kapalı';
        return voice.selfSpeaking ? 'Konuşuyorsun' : 'Sesli sohbet açık';
      default:
        return 'Sesli sohbeti aç';
    }
  })();

  // Pulse the mic button while the rider's own voice is going out, so they get
  // live confirmation that the group can hear them.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!selfLive) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 600, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [selfLive, pulse]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: `Grup · ${code}` });
  }, [navigation, code]);

  // Maps-style: keep the screen on for the whole group session so it never
  // dims/locks mid-ride. Released as soon as the screen unmounts.
  useEffect(() => {
    const tag = 'morider-group-ride';
    void activateKeepAwakeAsync(tag);
    return () => {
      void deactivateKeepAwake(tag);
    };
  }, []);

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
      // Turn-by-turn steps for the session route (best effort, once).
      routePointsRef.current = pts.map((p) => ({ lat: p.latitude, lon: p.longitude }));
      if (pts.length > 1 && !navSteps.current) {
        fetchRouteSteps(routePointsRef.current)
          .then((steps) => {
            if (steps.length > 0) navSteps.current = steps;
          })
          .catch(() => {});
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
        // Group alert: another rider's crash countdown expired. Vibrate hard,
        // tell everyone who and where, and offer to jump to the location.
        if (raw.type === 'sos') {
          if (raw.user_id === user?.id) return; // our own echo
          Vibration.vibrate([400, 300, 400, 300, 400]);
          const hasLoc = raw.has_loc && raw.lat != null && raw.lon != null;
          const goto = () =>
            hasLoc &&
            mapRef.current?.animateToRegion(
              { latitude: raw.lat, longitude: raw.lon, latitudeDelta: 0.005, longitudeDelta: 0.005 },
              600,
            );
          Alert.alert(
            '🚨 ACİL DURUM',
            hasLoc
              ? `${raw.name ?? 'Bir sürücü'} kaza yapmış olabilir! Son konumuna gidip durumu kontrol et.`
              : `${raw.name ?? 'Bir sürücü'} kaza yapmış olabilir! (Konum alınamadı.)`,
            hasLoc
              ? [
                  { text: 'Konuma Git', onPress: goto },
                  { text: 'Tamam', style: 'cancel' },
                ]
              : [{ text: 'Tamam', style: 'cancel' }],
          );
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
          rxAt: Date.now(),
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

  // Push our latest position over whatever socket is currently open.
  function sendPosition() {
    const c = lastCoord.current;
    if (c && ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ lat: c.lat, lon: c.lon, speed: c.speed }));
    }
  }

  // Advance the turn-by-turn banner for the rider's own position.
  function updateNavigation(pos: { lat: number; lon: number }): void {
    const steps = navSteps.current;
    if (!steps) return;
    const idx = advanceStep(steps, pos, navIdx.current);
    navIdx.current = idx;
    if (idx >= steps.length) {
      navSteps.current = null;
      setNavStep(null);
      return;
    }
    const step = steps[idx];
    const d = distanceM(pos, step);
    setNavStep(step);
    setNavDist(d);
    maybeSpeak(spoken.current, idx, step, d, voiceRef.current);
    maybeReroute(pos);
  }

  // Strayed from the group's route → refresh own guidance with a path that
  // rejoins it ahead. The shared route polyline stays untouched; only this
  // rider's banner instructions change.
  function maybeReroute(pos: LatLon): void {
    if (!navSteps.current) return;
    if (!offRouteTick(reroute.current, routePointsRef.current, pos)) return;
    reroute.current.inFlight = true;
    rerouteFromPosition(routePointsRef.current, pos)
      .then(({ steps }) => {
        if (steps.length === 0) return;
        navSteps.current = steps;
        navIdx.current = 0;
        // The shared group route stays as the deviation reference, so the
        // counter must restart from zero or the cooldown alone would let
        // re-routes fire back to back while riding the detour.
        reroute.current.offCount = 0;
        spoken.current = { idx: -1, far: false, near: false };
        speakRerouted(voiceRef.current);
      })
      .catch(() => {})
      .finally(() => {
        reroute.current.lastAt = Date.now();
        reroute.current.inFlight = false;
      });
  }

  // Ask for location permission once and stream our own GPS. We send on every
  // GPS update AND on a steady heartbeat, so a stationary rider still appears to
  // the rest of the group (GPS fixes alone fire only when you move).
  const startLocationWatch = useCallback(async () => {
    if (closed.current) return;

    // Seed an immediate position so the group sees us right away, and centre.
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      lastCoord.current = {
        lat: loc.coords.latitude,
        lon: loc.coords.longitude,
        speed: Math.max(0, (loc.coords.speed ?? 0) * 3.6),
      };
      sendPosition();
      if (!centered.current && !hasRoute.current) {
        centered.current = true;
        mapRef.current?.animateToRegion(
          { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 },
          600,
        );
      }
    } catch {
      // ignore — the recorder will still pick up a fix
    }

    if (closed.current) return;

    // Riding with the group *is* riding: the recorder streams GPS through the
    // same background service, and the session ends with a saved ride instead
    // of nothing. Auto-pause covers the twenty minutes everyone spends standing
    // around the meet point.
    await rec.start();

    // Heartbeat: re-broadcast the last position every 3s even when stationary,
    // so a stopped rider doesn't vanish from everyone else's map.
    if (heartbeat.current) clearInterval(heartbeat.current);
    heartbeat.current = setInterval(sendPosition, 3000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Reset per-ride state so switching sessions (code change) starts clean.
    closed.current = false;
    centered.current = false;
    camPrimed.current = false;
    reconnectAttempts.current = 0;
    setPositions({});
    void flushSOSQueue(); // an alert raised in a dead zone gets another chance
    loadSession();
    connectWS();
    startLocationWatch();
    return () => {
      closed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (heartbeat.current) clearInterval(heartbeat.current);
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
    if (heartbeat.current) clearInterval(heartbeat.current);
    // The ride is saved even when the session ends against the rider's will
    // (kicked, banned, host finished): they still rode those kilometres.
    void rec.stop();
    navSteps.current = null;
    stopSpeaking();
    detachSocket();
  }

  // Crash detection tracks *riding*, not connectivity. Keying it on the socket
  // meant it switched itself off in a tunnel or a dead zone — exactly where a
  // crash is most likely and help is furthest away — and stayed armed while
  // standing around at the meet point, where a dropped phone reads as an impact.
  const [riding, setRiding] = useState(false);
  useEffect(() => {
    // Latch on once the rider is clearly moving; a stop at lights shouldn't
    // disarm detection, so only a long standstill turns it back off.
    const t = setInterval(() => {
      const moving = (lastCoord.current?.speed ?? 0) > 5;
      if (moving) {
        lastMovedAt.current = Date.now();
        setRiding(true);
      } else if (Date.now() - lastMovedAt.current > 5 * 60_000) {
        setRiding(false);
      }
    }, 5000);
    return () => clearInterval(t);
  }, []);
  useCrashDetection(riding, () => setCrashAlarm(true));

  async function sendSOS() {
    setCrashAlarm(false);
    const c = lastCoord.current;
    // No GPS fix yet (e.g. crash seconds after connecting, or permission
    // denied): flag the SOS as location-less rather than reporting 0,0, which
    // would point rescuers at the Gulf of Guinea.
    const hasLoc = c?.lat != null && c?.lon != null;

    // The socket reaches only riders with this screen open — which, mid-ride
    // with the phone pocketed, is close to nobody. Send it anyway for the
    // instant path, but the server call is what actually delivers: it records
    // the alert, pushes it to the whole group's devices, and is retried from a
    // queue if there's no signal right now.
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(
        JSON.stringify({ type: 'sos', has_loc: hasLoc, lat: c?.lat ?? 0, lon: c?.lon ?? 0 }),
      );
    }
    const res = await raiseSOS({
      client_id: newSosId(),
      session_code: code,
      lat: hasLoc ? c?.lat : undefined,
      lon: hasLoc ? c?.lon : undefined,
      source: 'crash',
      raised_at: new Date().toISOString(),
    });

    const contact = await getEmergencyContact();
    if (contact) {
      try {
        await composeEmergencySMS(contact, hasLoc ? c?.lat : undefined, hasLoc ? c?.lon : undefined);
        return;
      } catch {
        // SMS composer unavailable — the server alert already went out
      }
    }
    Alert.alert(
      'Acil durum bildirildi',
      res.status === 'queued'
        ? 'İnternet yok. Bildirim sinyal gelir gelmez gruba gönderilecek.'
        : res.notified > 0
          ? `Gruptaki ${res.notified} sürücüye bildirim gönderildi.`
          : 'Kaydedildi, ancak şu anda ulaşılabilir sürücü yok.',
    );
  }

  // Deep link that lands on GroupJoin and auto-joins (morider://join/<code>;
  // in Expo Go dev builds createURL produces the matching exp:// URL).
  const inviteUrl = Linking.createURL(`join/${code}`);

  async function shareInvite() {
    try {
      await Share.share({
        message: `Morider grup sürüşüme katıl!\n\nLink: ${inviteUrl}\nKod: ${code}`,
      });
    } catch {
      // ignore
    }
  }

  // Ending a group ride deliberately saves it and shows the same summary a solo
  // ride gets — the kilometres are identical, and so is what the rider earned.
  async function finishRide(): Promise<boolean> {
    const summary = await rec.stop();
    if (!summary) return false;
    setLastRideSummary(summary);
    return true;
  }

  async function leave() {
    if (leaving.current) return;
    leaving.current = true;
    const hasSummary = await finishRide();
    teardown();
    try {
      await api.post(`/api/sessions/${code}/leave`);
    } catch {
      // best effort
    }
    if (hasSummary) navigation.replace('RideSummary');
    else navigation.goBack();
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
          const hasSummary = await finishRide();
          teardown();
          try {
            await api.post(`/api/sessions/${code}/end`);
          } catch {
            // best effort
          }
          if (hasSummary) navigation.replace('RideSummary');
          else navigation.goBack();
        },
      },
    ]);
  }

  // Close the sheet and zoom the map onto a participant's live position. Drops
  // the chase cam first, otherwise the next GPS fix (seconds away) yanks the
  // camera straight back and the feature appears broken.
  function focusUser(id: number) {
    const m = positions[id];
    if (!m) return;
    setShowParticipants(false);
    setFollowCam(false);
    mapRef.current?.animateToRegion({ latitude: m.lat, longitude: m.lon, latitudeDelta: 0.004, longitudeDelta: 0.004 }, 600);
  }

  // Resume the chase cam after the rider has looked around.
  function recenterOnSelf() {
    setFollowCam(true);
    camPrimed.current = false;
    const c = lastCoord.current;
    if (c) {
      mapRef.current?.animateCamera(
        { center: { latitude: c.lat, longitude: c.lon }, pitch: 55, zoom: 17.5 },
        { duration: 500 },
      );
    }
  }

  // Fit every live rider (plus us) on screen — the "where is everyone" view.
  function fitGroup() {
    const pts: Coord[] = Object.values(positions).map((m) => ({ latitude: m.lat, longitude: m.lon }));
    const c = lastCoord.current;
    if (c) pts.push({ latitude: c.lat, longitude: c.lon });
    if (pts.length < 2) return;
    setFollowCam(false);
    mapRef.current?.fitToCoordinates(pts, {
      edgePadding: { top: 140, right: 80, bottom: 260, left: 80 },
      animated: true,
    });
  }

  // Host-only moderation. State updates arrive for everyone via control frames.
  async function moderate(action: 'kick' | 'ban' | 'transfer', id: number) {
    try {
      await api.post(`/api/sessions/${code}/${action}`, { user_id: id });
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    }
  }

  // Host moderation lives in a sheet, not an Alert: Android's AlertDialog only
  // renders three buttons and silently drops the rest, so the five-option alert
  // this replaces hid "Banla" and "Vazgeç" entirely on Android. The sheet also
  // gives the rows a proper 56dp target. Confirmations stay as two-button
  // Alerts, which are safe on both platforms.
  const [hostTarget, setHostTarget] = useState<{ id: number; name: string } | null>(null);

  function confirmModerate(action: 'kick' | 'ban' | 'transfer', id: number, name: string) {
    setHostTarget(null);
    const copy = {
      transfer: { title: 'Host devret', body: `${name} yeni host olsun mu?`, ok: 'Devret', destructive: false },
      kick: { title: 'Sürüşten at', body: `${name} atılsın mı? Tekrar katılabilir.`, ok: 'At', destructive: true },
      ban: { title: 'Banla', body: `${name} banlansın mı? Bu sürüşe tekrar katılamaz.`, ok: 'Banla', destructive: true },
    }[action];
    Alert.alert(copy.title, copy.body, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: copy.ok,
        style: copy.destructive ? 'destructive' : 'default',
        onPress: () => moderate(action, id),
      },
    ]);
  }

  // Other participants' live markers (our own position shows as the blue dot).
  const others = Object.values(positions).filter((m) => m.userId !== user?.id);

  // Roster for the participants sheet: everyone who joined (from the API) merged
  // with anyone currently streaming a position (covers a stale joined list).
  // `state` mirrors the map markers: a rider who stopped reporting is "lost",
  // not "waiting" — the old two-state flag described a dead rider as pending.
  type RosterState = 'live' | 'lagging' | 'lost' | 'waiting';
  type Roster = { id: number; name: string; state: RosterState };
  const stateFor = (id: number): RosterState => {
    if (id === user?.id) return connected ? 'live' : 'lost';
    const m = positions[id];
    return m ? markerAge(m, now) : 'waiting';
  };
  const roster: Roster[] = (() => {
    const byId = new Map<number, Roster>();
    for (const p of participants) byId.set(p.id, { id: p.id, name: p.name, state: stateFor(p.id) });
    for (const m of Object.values(positions)) {
      if (!byId.has(m.userId)) byId.set(m.userId, { id: m.userId, name: m.name, state: stateFor(m.userId) });
    }
    if (user && !byId.has(user.id)) byId.set(user.id, { id: user.id, name: user.name, state: stateFor(user.id) });
    return Array.from(byId.values());
  })();
  const liveTotal = roster.filter((r) => r.state === 'live').length;

  // Cohesion. Everyone's position was already arriving; this is what turns it
  // into the one thing a group ride actually needs to know.
  //
  // Evaluated in an effect rather than during render: it is a state machine
  // that feeds its previous tick back in, and advancing that from the render
  // phase would step it twice under React's double-render.
  useEffect(() => {
    const list: CohesionRider[] = Object.values(positions).map((m) => ({
      userId: m.userId,
      name: m.name,
      lat: m.lat,
      lon: m.lon,
      fresh: markerAge(m, now) === 'live',
    }));
    // Our own position never comes back over the socket, so add it by hand —
    // without it the rider who is dropped is the one person the centre ignores.
    const c = lastCoord.current;
    if (user && c && !list.some((r) => r.userId === user.id)) {
      list.push({ userId: user.id, name: user.name, lat: c.lat, lon: c.lon, fresh: connected });
    }
    const next = evaluateCohesion(list, prevGap.current, prevCohesion.current);
    prevGap.current = next.gapKm;
    prevCohesion.current = next.state;
    setCohesion(next);
  }, [positions, now, connected, user]);

  const meDropped = user ? cohesion.state[user.id] === 'dropped' : false;
  const myGapKm = user ? cohesion.gapKm[user.id] : undefined;
  const othersDropped = cohesion.dropped.filter((d) => d.userId !== user?.id);

  // Say it out loud. A rider who has just come off the back is, by definition,
  // riding — not looking at a phone. The banner is for when they next glance
  // down; the announcement is what actually reaches them, through the helmet
  // intercom they are already wearing for voice chat.
  useEffect(() => {
    const nowDropped = new Set(cohesion.dropped.map((d) => d.userId));
    for (const d of cohesion.dropped) {
      if (announced.current.has(d.userId)) continue;
      announced.current.add(d.userId);
      Vibration.vibrate([0, 300, 150, 300]);
      // With a pair there is no "group" to fall off — say the gap instead.
      const line =
        cohesion.liveCount === 2
          ? `Aranızda ${fmtGap(d.gapKm * 2)} mesafe var.`
          : d.userId === user?.id
            ? `Gruptan koptun. ${fmtGap(d.gapKm)} uzaktasın.`
            : `${d.name} gruptan koptu. ${fmtGap(d.gapKm)} uzakta.`;
      Speech.stop();
      Speech.speak(line, { language: 'tr-TR' });
    }
    // Rejoining clears the latch, so a second separation is announced again.
    for (const id of Array.from(announced.current)) {
      if (!nowDropped.has(id)) announced.current.delete(id);
    }
  }, [cohesion.dropped, user?.id]);
  const ROSTER_LABEL: Record<RosterState, string> = {
    live: 'Canlı',
    lagging: 'Gecikmeli',
    lost: 'Bağlantı yok',
    waiting: 'Bekleniyor',
  };

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
        onPanDrag={() => setFollowCam(false)}
      >
        {/* Google-Maps-style route guide, matching MapScreen: a bright blue
            fill over a darker casing, solid with rounded caps/joins. */}
        {routePath.length > 1 && (
          <>
            <Polyline coordinates={routePath} strokeColor={navRouteCasing} strokeWidth={12} lineCap="round" lineJoin="round" zIndex={1} />
            <Polyline coordinates={routePath} strokeColor={navRouteFill} strokeWidth={8} lineCap="round" lineJoin="round" zIndex={2} />
            <Marker coordinate={routePath[0]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={3}>
              <View style={[styles.abPin, styles.aPin]}>
                <Text style={styles.abPinText}>A</Text>
              </View>
            </Marker>
            <Marker coordinate={routePath[routePath.length - 1]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={3}>
              <View style={[styles.abPin, styles.bPin]}>
                <Text style={styles.abPinText}>B</Text>
              </View>
            </Marker>
          </>
        )}
        {others.map((m) => {
          const age = markerAge(m, now);
          return (
            <Marker
              // tracksViewChanges is off (it re-rasterises the pin on every
              // frame otherwise — expensive with a group of 15). The age and
              // speaking styles therefore need a remount to take effect, which
              // the key provides: it changes at most a few times per rider.
              key={`${m.userId}-${age}-${speakingSet.has(m.userId) ? 'on' : 'off'}`}
              coordinate={{ latitude: m.lat, longitude: m.lon }}
              title={m.name}
              description={
                age === 'live' ? `${m.speed.toFixed(0)} km/s` : `Son konum · ${fmtAge(now - m.rxAt)}`
              }
              pinColor={colorFor(m.userId)}
              tracksViewChanges={false}
              opacity={age === 'live' ? 1 : age === 'lagging' ? 0.55 : 0.3}
            >
              <View
                style={[
                  styles.marker,
                  { backgroundColor: age === 'lost' ? colors.textFaint : colorFor(m.userId) },
                  age !== 'live' && styles.markerStale,
                  speakingSet.has(m.userId) && styles.markerSpeaking,
                ]}
              >
                <Text style={styles.markerText}>{m.name?.charAt(0).toUpperCase() ?? '?'}</Text>
              </View>
            </Marker>
          );
        })}
      </MapView>

      {/* Turn-by-turn banner (when the session has a route) or the status badge */}
      {navStep ? (
        <NavBanner
          step={navStep}
          distM={navDist}
          voiceOn={voiceOn}
          onToggleVoice={() => setVoiceOn((v) => !v)}
          topInset={insets.top}
        />
      ) : (
        <View style={[styles.badgeWrap, { top: insets.top + spacing.sm }]} pointerEvents="none">
          <View style={[styles.badge, connected ? styles.badgeLive : styles.badgeIdle]}>
            <View style={[styles.dot, { backgroundColor: connected ? colors.success : colors.textMuted }]} />
            <Text style={styles.badgeText}>{connected ? 'CANLI' : 'BAĞLANIYOR…'}</Text>
          </View>
        </View>
      )}

      {/* Cohesion strip. Sits directly under the maneuver banner so the answer
          to "where is everyone" arrives without touching the map — which is
          what stops riders staring at moving dots mid-corner. */}
      {cohesion.centre && (meDropped || othersDropped.length > 0) && (
        <View style={[styles.cohesionBar, { top: insets.top + (navStep ? 132 : 56) }]}>
          <MaterialCommunityIcons
            name={meDropped ? 'account-arrow-left' : 'account-alert'}
            size={20}
            color={ON_ACCENT}
          />
          <Text style={styles.cohesionText} numberOfLines={2}>
            {cohesion.liveCount === 2
              ? `Aranızda ${fmtGap((myGapKm ?? othersDropped[0]?.gapKm ?? 0) * 2)} var`
              : meDropped
                ? `Gruptan koptun · ${myGapKm != null ? fmtGap(myGapKm) : ''} uzaktasın`
                : othersDropped.length === 1
                  ? `${othersDropped[0].name} koptu · ${fmtGap(othersDropped[0].gapKm)} uzakta`
                  : `${othersDropped.length} sürücü gruptan koptu`}
          </Text>
          <Pressable
            style={styles.cohesionBtn}
            onPress={() => {
              // Fit me and the group centre together: the honest thing to show
              // is the gap and its direction. Turn-by-turn to a moving group
              // would be a promise the data can't keep.
              const c = lastCoord.current;
              const pts: Coord[] = [];
              if (cohesion.centre) pts.push({ latitude: cohesion.centre.lat, longitude: cohesion.centre.lon });
              if (c) pts.push({ latitude: c.lat, longitude: c.lon });
              for (const d of othersDropped) {
                const m = positions[d.userId];
                if (m) pts.push({ latitude: m.lat, longitude: m.lon });
              }
              if (pts.length < 2) return;
              setFollowCam(false);
              mapRef.current?.fitToCoordinates(pts, {
                edgePadding: { top: 180, right: 80, bottom: 280, left: 80 },
                animated: true,
              });
            }}
            accessibilityRole="button"
            accessibilityLabel={meDropped ? 'Grubun konumunu göster' : 'Kopan sürücüyü haritada göster'}
          >
            <Text style={styles.cohesionBtnText}>{meDropped ? 'Grubu göster' : 'Göster'}</Text>
          </Pressable>
        </View>
      )}

      {/* Camera controls: fit the whole group, or resume following yourself. */}
      <View style={[styles.camControls, { bottom: insets.bottom + 250 }]} pointerEvents="box-none">
        <Pressable
          style={styles.camBtn}
          onPress={fitGroup}
          accessibilityRole="button"
          accessibilityLabel="Tüm grubu haritaya sığdır"
        >
          <MaterialCommunityIcons name="account-group" size={20} color={colors.text} />
        </Pressable>
        {!followCam && (
          <Pressable
            style={[styles.camBtn, styles.camBtnActive]}
            onPress={recenterOnSelf}
            accessibilityRole="button"
            accessibilityLabel="Haritayı kendi konumuma geri ortala"
          >
            <MaterialCommunityIcons name="crosshairs-gps" size={20} color="#fff" />
          </Pressable>
        )}
      </View>

      {/* Always-on voice chat controls (float above the session panel). */}
      <View style={[styles.voiceControls, { bottom: insets.bottom + 160 }]}>
        {/* Status line — always present so the rider can tell at a glance whether
            voice is connecting, live, muted, or failed. */}
        <View
          style={[
            styles.voiceStatus,
            voice.status === 'connected' && !voice.muted && styles.voiceStatusLive,
            voice.status === 'error' && styles.voiceStatusError,
            selfLive && styles.voiceStatusTalking,
          ]}
        >
          {voice.status === 'connecting' ? (
            <View style={[styles.voiceStatusDot, { backgroundColor: colors.textMuted }]} />
          ) : selfLive ? (
            <MaterialCommunityIcons name="waveform" size={14} color={ON_ACCENT} />
          ) : voice.status === 'connected' ? (
            <View
              style={[
                styles.voiceStatusDot,
                { backgroundColor: voice.muted ? colors.textMuted : ON_ACCENT },
              ]}
            />
          ) : null}
          <Text
            style={[
              styles.voiceStatusText,
              // Dark ink on the saturated status fills: white measured 2.2–3.3:1
              // on success/primary/danger and failed AA outright. Dark ink lands
              // at 5.9–8.0:1 and lets the fills stay as vivid as they are.
              (selfLive || (voice.status === 'connected' && !voice.muted) || voice.status === 'error') && {
                color: ON_ACCENT,
              },
            ]}
          >
            {voiceLabel}
            {voice.status === 'connected' && voice.peers > 0 ? ` · ${voice.peers + 1} kişi` : ''}
          </Text>
        </View>

        <View style={styles.voiceBtnRow}>
          {voice.status === 'connected' && (
            <Pressable
              style={[styles.voiceBtn, voice.muted ? styles.voiceBtnMuted : styles.voiceBtnLive]}
              onPress={() => voice.toggleMute()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={voice.muted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}
              accessibilityState={{ selected: !voice.muted }}
            >
              {/* Pulsing ring confirms the mic is actually transmitting. */}
              {selfLive && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.voicePulse,
                    {
                      opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
                      transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }],
                    },
                  ]}
                />
              )}
              <MaterialCommunityIcons
                name={voice.muted ? 'microphone-off' : 'microphone'}
                size={22}
                color={voice.muted ? colors.textMuted : ON_ACCENT}
              />
            </Pressable>
          )}
          <Pressable
            style={[
              styles.voiceBtn,
              voice.status === 'connected' ? styles.voiceBtnOn : styles.voiceBtnOff,
            ]}
            onPress={toggleVoice}
            disabled={voice.status === 'connecting'}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={voiceLabel}
            accessibilityState={{ selected: voice.status === 'connected', disabled: voice.status === 'connecting' }}
          >
            <MaterialCommunityIcons
              name={
                voice.status === 'connected'
                  ? 'phone-in-talk'
                  : voice.status === 'connecting'
                    ? 'phone-sync'
                    : 'phone-plus'
              }
              size={22}
              color={voice.status === 'connected' ? ON_ACCENT : colors.text}
            />
            {voice.status === 'connected' && voice.peers > 0 && (
              <View style={styles.voiceBadge}>
                <Text style={styles.voiceBadgeText}>{voice.peers + 1}</Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>

      <Card style={[styles.panel, { bottom: insets.bottom + spacing.sm }]}>
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.codeLabel}>Oturum kodu</Text>
            <Text style={styles.code}>{code}</Text>
          </View>
          <Pressable
            style={styles.countWrap}
            onPress={() => {
              loadSession(false); // refresh the roster without re-fitting the map
              setShowParticipants(true);
            }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={`${liveTotal} sürücü canlı, ${roster.length} kişi katıldı. Katılımcı listesini aç.`}
          >
            <MaterialCommunityIcons name="account-group" size={18} color={colors.primary} />
            <Text style={styles.count}>
              {liveTotal} <Text style={styles.countTotal}>/ {roster.length}</Text>
            </Text>
            <MaterialCommunityIcons name="chevron-up" size={16} color={colors.textMuted} />
          </Pressable>
          <Pressable
            style={styles.shareBtn}
            onPress={() => setShowInvite(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Davet QR kodunu göster"
          >
            <MaterialCommunityIcons name="qrcode" size={20} color={colors.text} />
          </Pressable>
        </View>
        {/* Riders need to see that the group ride is being recorded — otherwise
            the kilometres appearing afterwards look like a surprise, and a
            paused ride looks like a broken one. */}
        {rec.recording && (
          <View style={styles.recRow}>
            <View style={[styles.recDot, { backgroundColor: rec.paused ? colors.warning : colors.danger }]} />
            <Text style={styles.recText}>
              {rec.paused ? (rec.autoPaused ? 'Otomatik duraklatıldı' : 'Duraklatıldı') : 'Sürüş kaydediliyor'}
            </Text>
            <Text style={styles.recKm}>{rec.distance.toFixed(1)} km</Text>
          </View>
        )}
        {isHost ? (
          <Button title="Grup Sürüşünü Bitir" variant="danger" icon="stop-circle" onPress={confirmEnd} />
        ) : (
          <Button title="Ayrıl" variant="ghost" icon="exit-run" onPress={leave} />
        )}
      </Card>

      <CrashCountdown visible={crashAlarm} onCancel={() => setCrashAlarm(false)} onExpire={sendSOS} />

      <Modal visible={showInvite} animationType="fade" transparent onRequestClose={() => setShowInvite(false)}>
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setShowInvite(false)}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        >
          <Pressable style={styles.inviteCard} onPress={() => {}} accessible={false}>
            <Text style={styles.inviteTitle}>Arkadaşlarını Davet Et</Text>
            <Text style={styles.inviteSub}>QR kodu okutsunlar ya da daveti link olarak gönder.</Text>
            <View style={styles.qrWrap}>
              <QRCode value={inviteUrl} size={200} backgroundColor="#fff" color="#000" />
            </View>
            <Text style={styles.inviteCode}>{code}</Text>
            <Button title="Davet Linkini Paylaş" icon="share-variant" onPress={shareInvite} />
            <Button title="Kapat" variant="ghost" onPress={() => setShowInvite(false)} />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showParticipants} animationType="slide" transparent onRequestClose={() => setShowParticipants(false)}>
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setShowParticipants(false)}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        >
          <Pressable style={styles.sheet} onPress={() => {}} accessible={false}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Katılımcılar</Text>
              <Text style={styles.sheetSub}>{liveTotal} canlı · {roster.length} toplam</Text>
            </View>
            <ScrollView style={styles.sheetList}>
              {roster.map((r) => {
                const canFocus = !!positions[r.id];
                const isLive = r.state === 'live';
                return (
                  <Pressable
                    key={r.id}
                    style={({ pressed }) => [styles.pRow, pressed && canFocus && styles.pRowPressed]}
                    onPress={() => focusUser(r.id)}
                    disabled={!canFocus}
                    accessibilityRole="button"
                    accessibilityLabel={`${r.name}${r.id === hostId ? ', host' : ''}. ${ROSTER_LABEL[r.state]}.${
                      canFocus ? ' Haritada göstermek için dokun.' : ''
                    }`}
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
                    {speakingSet.has(r.id) ? (
                      <MaterialCommunityIcons name="microphone" size={18} color={colors.success} />
                    ) : null}
                    <View
                      style={[
                        styles.pStatus,
                        isLive ? styles.pStatusLive : r.state === 'lost' ? styles.pStatusLost : styles.pStatusIdle,
                      ]}
                    >
                      <View
                        style={[
                          styles.pStatusDot,
                          {
                            backgroundColor: isLive
                              ? colors.success
                              : r.state === 'lost'
                                ? colors.danger
                                : colors.warning,
                          },
                        ]}
                      />
                      <Text style={styles.pStatusText}>{ROSTER_LABEL[r.state]}</Text>
                    </View>
                    {isHost && r.id !== user?.id ? (
                      <Pressable
                        hitSlop={12}
                        onPress={() => setHostTarget({ id: r.id, name: r.name })}
                        style={styles.pMenuBtn}
                        accessibilityRole="button"
                        accessibilityLabel={`${r.name} için host işlemleri`}
                      >
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

      {/* Host moderation actions for one participant. */}
      <Modal
        visible={hostTarget != null}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setHostTarget(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setHostTarget(null)}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        >
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>{hostTarget?.name}</Text>
            <Text style={styles.sheetSub}>Host işlemleri</Text>
            <View style={{ height: spacing.sm }} />
            {hostTarget && positions[hostTarget.id] ? (
              <ActionRow
                icon="crosshairs-gps"
                label="Haritada göster"
                onPress={() => {
                  const t = hostTarget;
                  setHostTarget(null);
                  focusUser(t.id);
                }}
              />
            ) : null}
            <ActionRow
              icon="crown-outline"
              label="Host yap (devret)"
              onPress={() => hostTarget && confirmModerate('transfer', hostTarget.id, hostTarget.name)}
            />
            <ActionRow
              icon="exit-run"
              label="Sürüşten at"
              danger
              onPress={() => hostTarget && confirmModerate('kick', hostTarget.id, hostTarget.name)}
            />
            <ActionRow
              icon="cancel"
              label="Banla"
              danger
              onPress={() => hostTarget && confirmModerate('ban', hostTarget.id, hostTarget.name)}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// One 56dp row in the host action sheet — big enough for gloved taps, and free
// of the platform button limits an Alert would impose.
function ActionRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons name={icon} size={22} color={danger ? colors.danger : colors.text} />
      <Text style={[styles.actionLabel, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
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
  markerSpeaking: { borderColor: colors.success, borderWidth: 3 },
  markerStale: { borderColor: colors.textMuted, borderStyle: 'dashed' },
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
  badgeWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
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
  voiceControls: {
    position: 'absolute',
    right: spacing.md,
    gap: spacing.sm,
    alignItems: 'flex-end',
  },
  cohesionBar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Amber, not red: a split group is a problem to fix, not an emergency.
    // Red belongs to the crash alert and must keep meaning only that.
    backgroundColor: colors.warning,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    ...shadow.card,
  },
  cohesionText: { color: ON_ACCENT, fontSize: 14, fontWeight: '800', flex: 1, lineHeight: 18 },
  cohesionBtn: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(11,13,16,0.16)',
  },
  cohesionBtnText: { color: ON_ACCENT, fontSize: 13, fontWeight: '900' },
  camControls: { position: 'absolute', right: spacing.md, gap: spacing.sm, alignItems: 'flex-end' },
  camBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  camBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  voiceStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  voiceStatusLive: { backgroundColor: colors.success, borderColor: colors.success },
  voiceStatusTalking: { backgroundColor: colors.primary, borderColor: colors.primary },
  voiceStatusError: { backgroundColor: colors.danger, borderColor: colors.danger },
  voiceStatusDot: { width: 8, height: 8, borderRadius: 4 },
  voiceStatusText: { color: colors.text, fontSize: 13, fontWeight: '800' },
  voiceBtnRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  voicePulse: {
    position: 'absolute',
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
  },
  voiceBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    ...shadow.card,
  },
  voiceBtnOff: { backgroundColor: colors.surface, borderColor: colors.border },
  voiceBtnOn: { backgroundColor: colors.success, borderColor: colors.success },
  voiceBtnLive: { backgroundColor: colors.primary, borderColor: colors.primary },
  voiceBtnMuted: { backgroundColor: colors.surface, borderColor: colors.border },
  voiceBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  voiceBadgeText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, gap: spacing.md },
  panelHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  codeLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  code: { color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: 3 },
  recRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  recDot: { width: 8, height: 8, borderRadius: 4 },
  recText: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1 },
  recKm: { color: colors.primary, fontSize: 15, fontWeight: '900', fontVariant: ['tabular-nums'] },
  countWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto', paddingVertical: spacing.sm },
  count: { color: colors.text, fontWeight: '800', fontSize: 15 },
  countTotal: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
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
  inviteCard: {
    alignSelf: 'center',
    marginBottom: 'auto',
    marginTop: 'auto',
    width: '86%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  inviteTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  inviteSub: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  qrWrap: { backgroundColor: '#fff', padding: spacing.md, borderRadius: radius.md, marginVertical: spacing.sm },
  inviteCode: { color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: 4 },
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
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: 56,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  actionRowPressed: { backgroundColor: colors.surfaceAlt },
  actionLabel: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pMenuBtn: { padding: spacing.xs },
  pDot: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  pDotText: { color: '#fff', fontWeight: '900' },
  pInfo: { flex: 1 },
  pName: { color: colors.text, fontWeight: '800' },
  pHost: { color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 1 },
  pStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1 },
  pStatusLive: { backgroundColor: 'rgba(47,210,122,0.12)', borderColor: colors.success },
  pStatusIdle: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  pStatusLost: { backgroundColor: 'rgba(255,77,77,0.12)', borderColor: colors.danger },
  pStatusDot: { width: 7, height: 7, borderRadius: 4 },
  pStatusText: { color: colors.text, fontSize: 12, fontWeight: '700' },
});
