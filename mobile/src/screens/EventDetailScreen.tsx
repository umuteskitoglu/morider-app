import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { AppTabParams, EventsStackParams } from '../navigation/RootNavigator';
import { Card } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { cancelEventReminders, scheduleEventReminders } from '../lib/eventReminders';
import { eventDraft } from '../lib/eventDraft';
import { formatDateTime, formatTime, timeUntil } from '../lib/datetime';
import { colors, onAccent, radius, spacing } from '../theme';

type Participant = { id: number; name: string; rsvp: string };
type ChatMsg = { id: number; user_id: number; name: string; body: string; created_at: string };
type Coord = { latitude: number; longitude: number };

type EventData = {
  event_id: number;
  code: string;
  host_id: number;
  title: string;
  description: string;
  meet_at: string;
  start_at: string;
  status: string;
  route_id: number;
  route_points: { lat: number; lon: number }[];
  start_lat: number | null;
  start_lon: number | null;
  start_name: string;
  end_lat: number | null;
  end_lon: number | null;
  end_name: string;
  participants: Participant[];
  // Code of the live group ride, present only while the host's ride is active.
  ride_session_code: string;
};

type Props = NativeStackScreenProps<EventsStackParams, 'EventDetail'>;

const RSVP_OPTIONS: { key: 'going' | 'maybe' | 'declined'; label: string; icon: string; color: string }[] = [
  { key: 'going', label: 'Geliyorum', icon: 'check-circle', color: colors.success },
  { key: 'maybe', label: 'Belki', icon: 'help-circle', color: colors.accent },
  { key: 'declined', label: 'Gelemiyorum', icon: 'close-circle', color: colors.danger },
];

const RSVP_TITLES: Record<string, string> = { going: 'Geliyor', maybe: 'Belki', declined: 'Gelemiyor' };

// How many recent messages to preview before the user opens the full chat.
const PREVIEW_COUNT = 3;

// Total length of a polyline in km (enough precision for a "~42 km" chip).
function pathKm(points: Coord[]): number {
  const R = 6371;
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
    const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    km += 2 * R * Math.asin(Math.sqrt(s));
  }
  return km;
}

export default function EventDetailScreen({ navigation, route }: Props) {
  const { code } = route.params;
  const { user } = useAuth();

  const [event, setEvent] = useState<EventData | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [myRsvp, setMyRsvp] = useState<string | null>(null);
  const [ridePending, setRidePending] = useState(false);

  const mapRef = useRef<MapView | null>(null);

  const isHost = event != null && user?.id === event.host_id;
  const canEdit = isHost && event?.status === 'scheduled';

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Etkinlik',
      headerRight: canEdit
        ? () => (
            <Pressable
              onPress={() => {
                eventDraft.reset();
                navigation.navigate('EventCreate', { code });
              }}
              hitSlop={8}
              style={styles.editBtn}
            >
              <MaterialCommunityIcons name="pencil" size={22} color={colors.primary} />
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, canEdit, code]);

  const loadEvent = useCallback(async () => {
    try {
      const { data } = await api.get<EventData>(`/api/events/${code}`);
      setEvent(data);
      const mine = data.participants.find((p) => p.id === user?.id);
      setMyRsvp(mine?.rsvp ?? null);
      const pts = (data.route_points ?? []).map((p) => ({ latitude: p.lat, longitude: p.lon }));
      if (pts.length > 1) {
        setTimeout(
          () => mapRef.current?.fitToCoordinates(pts, { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: true }),
          400,
        );
      }
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
      navigation.goBack();
    }
  }, [code, user?.id, navigation]);

  const loadMessages = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/events/${code}/messages`);
      setMessages(data.messages ?? []);
    } catch {
      // chat preview is best-effort (also 403 until you've joined)
    }
  }, [code]);

  // Reload on focus so the preview/roster refresh after returning from the chat.
  useFocusEffect(
    useCallback(() => {
      loadEvent();
      loadMessages();
    }, [loadEvent, loadMessages]),
  );

  async function setRsvp(value: 'going' | 'maybe' | 'declined') {
    try {
      await api.post(`/api/events/${code}/rsvp`, { rsvp: value });
      setMyRsvp(value);
      if (value === 'going' && event) {
        scheduleEventReminders(code, event.title, event.meet_at).catch(() => {});
      } else {
        cancelEventReminders(code).catch(() => {});
      }
      loadEvent();
      loadMessages();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    }
  }

  async function invite() {
    try {
      await Share.share({
        message: `Morider etkinliğime katıl: ${event?.title ?? ''}\nKod: ${code}\nmorider://event/${code}`,
      });
    } catch {
      // ignore
    }
  }

  // Opens the meet point in the platform's maps app for turn-by-turn directions —
  // the single most useful action before a group ride: get to the meeting spot.
  function openDirections() {
    if (!event) return;
    const target =
      event.start_lat != null && event.start_lon != null
        ? { lat: event.start_lat, lon: event.start_lon }
        : event.route_points?.length
          ? { lat: event.route_points[0].lat, lon: event.route_points[0].lon }
          : null;
    if (!target) return;
    const label = encodeURIComponent(event.start_name || event.title);
    const primary =
      Platform.OS === 'ios'
        ? `http://maps.apple.com/?daddr=${target.lat},${target.lon}`
        : `google.navigation:q=${target.lat},${target.lon}`;
    const fallback = `geo:${target.lat},${target.lon}?q=${target.lat},${target.lon}(${label})`;
    Linking.openURL(primary).catch(() =>
      Linking.openURL(fallback).catch(() => Alert.alert('Harita açılamadı', 'Cihazında bir harita uygulaması bulunamadı.')),
    );
  }

  // The live group-ride map lives in the Ride tab, so we hop tabs via the parent.
  function openRide(rideCode: string) {
    navigation
      .getParent<BottomTabNavigationProp<AppTabParams>>()
      ?.navigate('Ride', { screen: 'GroupRide', params: { code: rideCode } });
  }

  // Single entry point used by both the CTA and tapping the map:
  // host starts (or rejoins) the ride; "going" attendees join the host's; others
  // get a nudge about what they need to do first.
  async function handleRide() {
    if (!event || ridePending) return;
    const live = event.ride_session_code;
    try {
      setRidePending(true);
      if (isHost) {
        const { data } = await api.post(`/api/events/${code}/ride`);
        openRide(data.code);
        loadEvent();
        return;
      }
      if (!live) {
        Alert.alert('Sürüş başlamadı', 'Grup sürüşünü düzenleyen kişi başlatınca burada görünecek.');
        return;
      }
      if (myRsvp !== 'going') {
        Alert.alert('Önce katılım ver', "Sürüşe katılmak için katılım durumunu 'Geliyorum' olarak seç.");
        return;
      }
      await api.post(`/api/sessions/${live}/join`);
      openRide(live);
    } catch (err) {
      Alert.alert('Sürüşe bağlanılamadı', errorMessage(err));
    } finally {
      setRidePending(false);
    }
  }

  function confirmCancel() {
    Alert.alert('Etkinliği iptal et', 'Etkinlik tüm katılımcılar için iptal edilecek. Emin misin?', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'İptal et',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.post(`/api/events/${code}/cancel`);
            cancelEventReminders(code).catch(() => {});
            navigation.goBack();
          } catch (err) {
            Alert.alert('Hata', errorMessage(err));
          }
        },
      },
    ]);
  }

  if (!event) {
    return <View style={styles.container} />;
  }

  const routePath: Coord[] = (event.route_points ?? []).map((p) => ({ latitude: p.lat, longitude: p.lon }));
  const hasRoute = routePath.length > 1;
  const startCoord: Coord | null =
    event.start_lat != null && event.start_lon != null ? { latitude: event.start_lat, longitude: event.start_lon } : null;
  const endCoord: Coord | null =
    event.end_lat != null && event.end_lon != null ? { latitude: event.end_lat, longitude: event.end_lon } : null;

  const region: Region = hasRoute
    ? { ...routePath[0], latitudeDelta: 0.1, longitudeDelta: 0.1 }
    : startCoord
      ? { ...startCoord, latitudeDelta: 0.08, longitudeDelta: 0.08 }
      : { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.2, longitudeDelta: 0.2 };

  const grouped = {
    going: event.participants.filter((p) => p.rsvp === 'going'),
    maybe: event.participants.filter((p) => p.rsvp === 'maybe'),
    declined: event.participants.filter((p) => p.rsvp === 'declined'),
  };

  const cancelled = event.status === 'cancelled';
  const liveRide = !!event.ride_session_code;
  // Host can always start/rejoin; attendees only see the CTA once a ride is live.
  const showRideCta = !cancelled && (isHost || liveRide);
  const rideLabel = isHost
    ? liveRide
      ? 'Grup Sürüşüne Dön'
      : 'Grup Sürüşünü Başlat'
    : 'Sürüşe Katıl';
  // Last few messages, newest first for the preview.
  const preview = messages.slice(-PREVIEW_COUNT).reverse();

  const hostName = event.participants.find((p) => p.id === event.host_id)?.name ?? '';
  const remaining = timeUntil(event.meet_at);
  const meetPassed = !remaining && new Date(event.meet_at).getTime() <= Date.now();
  const routeKm = hasRoute ? pathKm(routePath) : 0;
  // Nudge people who were invited (opened via code/link) but haven't answered yet.
  const needsRsvp = !cancelled && !isHost && myRsvp == null;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {cancelled && (
          <View style={styles.cancelledBanner}>
            <MaterialCommunityIcons name="calendar-remove" size={18} color={colors.danger} />
            <Text style={styles.cancelledText}>Bu etkinlik iptal edildi</Text>
          </View>
        )}

        <Card style={styles.headerCard}>
          <Text style={styles.title}>{event.title}</Text>
          {hostName ? (
            <View style={styles.hostRow}>
              <MaterialCommunityIcons name="account-star" size={14} color={colors.textMuted} />
              <Text style={styles.hostRowText}>{`Düzenleyen: ${hostName}${isHost ? ' (sen)' : ''}`}</Text>
            </View>
          ) : null}
          {event.description ? <Text style={styles.description}>{event.description}</Text> : null}
          {!cancelled && (remaining || meetPassed) ? (
            <View style={[styles.countdownPill, meetPassed && styles.countdownPillPassed]}>
              <MaterialCommunityIcons
                name={meetPassed ? 'clock-alert-outline' : 'timer-sand'}
                size={14}
                color={meetPassed ? colors.textMuted : colors.primary}
              />
              <Text style={[styles.countdownText, meetPassed && styles.countdownTextPassed]}>
                {meetPassed ? 'Buluşma zamanı geçti' : `Buluşmaya ${remaining} kaldı`}
              </Text>
            </View>
          ) : null}
          <View style={styles.timeRow}>
            <View style={styles.timeItem}>
              <MaterialCommunityIcons name="map-marker-account" size={18} color={colors.primary} />
              <View>
                <Text style={styles.timeLabel}>BULUŞMA</Text>
                <Text style={styles.timeValue}>{formatDateTime(event.meet_at)}</Text>
              </View>
            </View>
            <View style={styles.timeItem}>
              <MaterialCommunityIcons name="flag-checkered" size={18} color={colors.accent} />
              <View>
                <Text style={styles.timeLabel}>KALKIŞ</Text>
                <Text style={styles.timeValue}>{formatTime(event.start_at)}</Text>
              </View>
            </View>
          </View>
          <Text style={styles.timeHint}>Buluşma: toplanma yeri ve saati · Kalkış: motorların yola çıkacağı saat</Text>
        </Card>

        {needsRsvp && (
          <View style={styles.rsvpNudge}>
            <MaterialCommunityIcons name="hand-wave" size={18} color={colors.accent} />
            <Text style={styles.rsvpNudgeText}>
              Bu sürüşe davetlisin! Aşağıdan katılım durumunu seç — seçince sohbete katılır ve hatırlatma alırsın.
            </Text>
          </View>
        )}

        {(hasRoute || startCoord) && (
          <Pressable style={styles.mapWrap} onPress={handleRide} accessibilityRole="button" accessibilityLabel="Buluşma noktasını haritada aç">
            <View style={styles.mapInner}>
              <MapView ref={mapRef} style={styles.map} initialRegion={region} pointerEvents="none">
                {hasRoute && (
                  <>
                    <Polyline coordinates={routePath} strokeColor={colors.accent} strokeWidth={5} />
                    <Marker coordinate={routePath[0]} pinColor={colors.success} />
                    <Marker coordinate={routePath[routePath.length - 1]} pinColor={colors.danger} />
                  </>
                )}
                {!hasRoute && startCoord && <Marker coordinate={startCoord} title="Başlangıç" pinColor={colors.success} />}
                {!hasRoute && endCoord && <Marker coordinate={endCoord} title="Bitiş" pinColor={colors.danger} />}
              </MapView>
              {liveRide ? (
                <View style={styles.liveBadge}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveBadgeText}>CANLI SÜRÜŞ</Text>
                </View>
              ) : null}
              {routeKm > 0.5 ? (
                <View style={styles.distanceBadge}>
                  <MaterialCommunityIcons name="map-marker-distance" size={13} color="#fff" />
                  <Text style={styles.distanceBadgeText}>{`~${Math.round(routeKm)} km`}</Text>
                </View>
              ) : null}
              <View style={styles.mapTapHint}>
                <MaterialCommunityIcons name="map-marker-radius" size={14} color="#fff" />
                <Text style={styles.mapTapHintText}>{liveRide ? 'Canlı haritayı aç' : 'Sürüş için dokun'}</Text>
              </View>
            </View>
            {!hasRoute && (event.start_name || event.end_name) ? (
              <View style={styles.locNames}>
                {event.start_name ? <Text style={styles.locName}>🏁 {event.start_name}</Text> : null}
                {event.end_name ? <Text style={styles.locName}>🎯 {event.end_name}</Text> : null}
              </View>
            ) : null}
          </Pressable>
        )}

        {(hasRoute || startCoord) && !cancelled && (
          <Pressable onPress={openDirections} accessibilityRole="button" accessibilityLabel="Buluşma noktasına yol tarifi al">
            <Card style={styles.directionsCard}>
              <MaterialCommunityIcons name="navigation-variant" size={20} color={colors.cyan} />
              <View style={{ flex: 1 }}>
                <Text style={styles.directionsTitle}>Buluşma noktasına yol tarifi</Text>
                <Text style={styles.directionsHint}>
                  {event.start_name ? event.start_name : 'Harita uygulamasında aç'}
                </Text>
              </View>
              <MaterialCommunityIcons name="open-in-new" size={18} color={colors.textMuted} />
            </Card>
          </Pressable>
        )}

        {showRideCta && (
          <Pressable
            style={[styles.rideCta, ridePending && styles.rideCtaDisabled]}
            onPress={handleRide}
            disabled={ridePending}
            accessibilityRole="button"
            accessibilityLabel={rideLabel}
            accessibilityState={{ disabled: ridePending }}
          >
            <MaterialCommunityIcons name={liveRide ? 'motorbike' : 'flag-checkered'} size={20} color="#fff" />
            <Text style={styles.rideCtaText}>{rideLabel}</Text>
          </Pressable>
        )}

        {!cancelled && !liveRide && !isHost && (
          <View style={styles.rideWaitStrip}>
            <MaterialCommunityIcons name="motorbike" size={16} color={colors.textMuted} />
            <Text style={styles.rideWaitText}>
              Sürüş günü düzenleyen canlı grup sürüşünü başlatınca buradan tek dokunuşla katılırsın.
            </Text>
          </View>
        )}

        {/* RSVP */}
        {!cancelled && (
          <Card style={[styles.rsvpCard, needsRsvp && styles.rsvpCardNudge]}>
            <Text style={styles.sectionTitle}>Katılım durumun</Text>
            <View style={styles.rsvpRow}>
              {RSVP_OPTIONS.map((opt) => {
                const active = myRsvp === opt.key;
                return (
                  <Pressable
                    key={opt.key}
                    style={[styles.rsvpBtn, active && { backgroundColor: opt.color, borderColor: opt.color }]}
                    onPress={() => setRsvp(opt.key)}
                  >
                    <MaterialCommunityIcons name={opt.icon as any} size={20} color={active ? '#fff' : opt.color} />
                    <Text style={[styles.rsvpBtnText, active && { color: '#fff' }]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.reminderHintRow}>
              <MaterialCommunityIcons name="bell-ring-outline" size={13} color={colors.textFaint} />
              <Text style={styles.reminderHint}>
                "Geliyorum" dersen buluşmadan 1 saat ve 15 dakika önce hatırlatma alırsın.
              </Text>
            </View>
          </Card>
        )}

        {/* Invite */}
        <Pressable onPress={invite} accessibilityRole="button" accessibilityLabel="Arkadaşlarını etkinliğe davet et">
          <Card style={styles.inviteCard}>
            <MaterialCommunityIcons name="share-variant" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.inviteTitle}>Arkadaşlarını davet et</Text>
              <Text style={styles.inviteCode}>Kod: {code}</Text>
              <Text style={styles.inviteHint}>Kodu gönder; arkadaşların "Kodla katıl" bölümünden girsin.</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
          </Card>
        </Pressable>

        {/* Attendance lists */}
        <Card style={styles.attendCard}>
          <Text style={styles.sectionTitle}>Katılımcılar</Text>
          {(['going', 'maybe', 'declined'] as const).map((key) => (
            <View key={key} style={styles.attendGroup}>
              <Text style={styles.attendGroupTitle}>
                {RSVP_TITLES[key]} · {grouped[key].length}
              </Text>
              {grouped[key].length === 0 ? (
                <Text style={styles.attendEmpty}>—</Text>
              ) : (
                grouped[key].map((p) => (
                  <View key={p.id} style={styles.personRow}>
                    <View style={styles.personDot}>
                      <Text style={styles.personDotText}>{p.name?.charAt(0).toUpperCase() ?? '?'}</Text>
                    </View>
                    <Text style={styles.personName}>
                      {p.name}
                      {p.id === user?.id ? ' (sen)' : ''}
                    </Text>
                    {p.id === event.host_id ? <Text style={styles.personHost}>Düzenleyen</Text> : null}
                  </View>
                ))
              )}
            </View>
          ))}
        </Card>

        {/* Chat preview → opens full-screen chat */}
        <Card style={styles.chatCard}>
          <View style={styles.chatHeader}>
            <Text style={styles.sectionTitle}>Sohbet</Text>
            {myRsvp != null && messages.length > 0 ? (
              <Text style={styles.chatCount}>{messages.length} mesaj</Text>
            ) : null}
          </View>

          {myRsvp == null ? (
            <Text style={styles.attendEmpty}>Sohbete katılmak için katılım durumunu seç.</Text>
          ) : preview.length === 0 ? (
            <Text style={styles.attendEmpty}>Henüz mesaj yok. İlk mesajı sen yaz!</Text>
          ) : (
            preview.map((m) => {
              const mine = m.user_id === user?.id;
              return (
                <View key={m.id} style={[styles.msgRow, mine && styles.msgRowMine]}>
                  <View style={[styles.msgBubble, mine ? styles.msgBubbleMine : styles.msgBubbleOther]}>
                    {!mine ? <Text style={styles.msgAuthor}>{m.name}</Text> : null}
                    <Text style={[styles.msgBody, mine && styles.msgBodyMine]}>{m.body}</Text>
                    <Text style={[styles.msgTime, mine && styles.msgTimeMine]}>{formatTime(m.created_at)}</Text>
                  </View>
                </View>
              );
            })
          )}

          {myRsvp != null && (
            <Pressable
              style={styles.openChatBtn}
              onPress={() => navigation.navigate('EventChat', { code, title: event.title })}
            >
              <MaterialCommunityIcons name="chat-processing" size={18} color="#fff" />
              <Text style={styles.openChatText}>Sohbeti Aç</Text>
            </Pressable>
          )}
        </Card>

        {isHost && !cancelled && (
          <Pressable
            onPress={confirmCancel}
            style={styles.cancelBtn}
            accessibilityRole="button"
            accessibilityLabel="Etkinliği iptal et"
          >
            <MaterialCommunityIcons name="calendar-remove" size={18} color={colors.danger} />
            <Text style={styles.cancelBtnText}>Etkinliği iptal et</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  editBtn: { paddingHorizontal: spacing.xs },
  scroll: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  cancelledBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,77,94,0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  cancelledText: { color: colors.danger, fontWeight: '800' },
  headerCard: { gap: spacing.sm },
  title: { color: colors.text, fontSize: 22, fontWeight: '900' },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: -4 },
  hostRowText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  description: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  countdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    backgroundColor: 'rgba(255,106,26,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.3)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  countdownPillPassed: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  countdownText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  countdownTextPassed: { color: colors.textMuted },
  timeRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
  timeHint: { color: colors.textFaint, fontSize: 12, lineHeight: 15, marginTop: 2 },
  rsvpNudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,176,32,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.35)',
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  rsvpNudgeText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 },
  timeItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  timeLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  timeValue: { color: colors.text, fontSize: 14, fontWeight: '700' },
  mapWrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  mapInner: { position: 'relative' },
  map: { height: 180 },
  liveBadge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.danger,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  liveBadgeText: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
  distanceBadge: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  distanceBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  mapTapHint: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
  },
  mapTapHintText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  rideCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  rideCtaDisabled: { opacity: 0.6 },
  rideCtaText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  rideWaitStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  rideWaitText: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  directionsCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  directionsTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  directionsHint: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  locNames: { padding: spacing.sm, gap: 2, backgroundColor: colors.surface },
  locName: { color: colors.text, fontSize: 13 },
  rsvpCard: { gap: spacing.sm },
  rsvpCardNudge: { borderColor: 'rgba(255,176,32,0.45)' },
  reminderHintRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  reminderHint: { flex: 1, color: colors.textFaint, fontSize: 12, lineHeight: 15 },
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  rsvpRow: { flexDirection: 'row', gap: spacing.sm },
  rsvpBtn: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  rsvpBtnText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  inviteCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  inviteTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  inviteCode: { color: colors.textMuted, fontSize: 13, marginTop: 1, letterSpacing: 1 },
  inviteHint: { color: colors.textFaint, fontSize: 12, marginTop: 2, lineHeight: 15 },
  attendCard: { gap: spacing.sm },
  attendGroup: { gap: spacing.xs },
  attendGroupTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  attendEmpty: { color: colors.textMuted, fontSize: 13 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  personDot: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  personDotText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  personName: { color: colors.text, fontWeight: '600', flex: 1 },
  personHost: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  chatCard: { gap: spacing.sm },
  chatHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chatCount: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.md },
  msgBubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 2 },
  msgBubbleOther: { backgroundColor: colors.surfaceAlt, borderBottomLeftRadius: 2 },
  msgAuthor: { color: colors.accent, fontSize: 12, fontWeight: '800', marginBottom: 1 },
  msgBody: { color: '#fff', fontSize: 15, paddingRight: 3 },
  // The outgoing bubble is filled with the brand orange, on which white
  // text measures 2.9:1. Dark ink on the same fill measures 6.8:1.
  msgBodyMine: { color: onAccent },
  msgTime: { color: 'rgba(255,255,255,0.7)', fontSize: 12, alignSelf: 'flex-end', marginTop: 1 },
  msgTimeMine: { color: 'rgba(11,13,16,0.8)' },
  openChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  openChatText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  cancelBtnText: { color: colors.danger, fontWeight: '800' },
});
