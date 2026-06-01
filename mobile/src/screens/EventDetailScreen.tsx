import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EventsStackParams } from '../navigation/RootNavigator';
import { Card } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { cancelEventReminders, scheduleEventReminders } from '../lib/eventReminders';
import { eventDraft } from '../lib/eventDraft';
import { formatDateTime, formatTime } from '../lib/datetime';
import { colors, radius, spacing } from '../theme';

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

export default function EventDetailScreen({ navigation, route }: Props) {
  const { code } = route.params;
  const { user } = useAuth();

  const [event, setEvent] = useState<EventData | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [myRsvp, setMyRsvp] = useState<string | null>(null);

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
  // Last few messages, newest first for the preview.
  const preview = messages.slice(-PREVIEW_COUNT).reverse();

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
          {event.description ? <Text style={styles.description}>{event.description}</Text> : null}
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
        </Card>

        {(hasRoute || startCoord) && (
          <View style={styles.mapWrap}>
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
            {!hasRoute && (event.start_name || event.end_name) ? (
              <View style={styles.locNames}>
                {event.start_name ? <Text style={styles.locName}>🏁 {event.start_name}</Text> : null}
                {event.end_name ? <Text style={styles.locName}>🎯 {event.end_name}</Text> : null}
              </View>
            ) : null}
          </View>
        )}

        {/* RSVP */}
        {!cancelled && (
          <Card style={styles.rsvpCard}>
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
          </Card>
        )}

        {/* Invite */}
        <Pressable onPress={invite}>
          <Card style={styles.inviteCard}>
            <MaterialCommunityIcons name="share-variant" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.inviteTitle}>Davet et</Text>
              <Text style={styles.inviteCode}>Kod: {code}</Text>
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
                    <Text style={styles.msgBody}>{m.body}</Text>
                    <Text style={styles.msgTime}>{formatTime(m.created_at)}</Text>
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
          <Pressable onPress={confirmCancel} style={styles.cancelBtn}>
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
  description: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  timeRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
  timeItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  timeLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  timeValue: { color: colors.text, fontSize: 14, fontWeight: '700' },
  mapWrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  map: { height: 180 },
  locNames: { padding: spacing.sm, gap: 2, backgroundColor: colors.surface },
  locName: { color: colors.text, fontSize: 13 },
  rsvpCard: { gap: spacing.sm },
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
  attendCard: { gap: spacing.sm },
  attendGroup: { gap: spacing.xs },
  attendGroupTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: spacing.xs,
  },
  attendEmpty: { color: colors.textMuted, fontSize: 13 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  personDot: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  personDotText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  personName: { color: colors.text, fontWeight: '600', flex: 1 },
  personHost: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  chatCard: { gap: spacing.sm },
  chatHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chatCount: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.md },
  msgBubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 2 },
  msgBubbleOther: { backgroundColor: colors.surfaceAlt, borderBottomLeftRadius: 2 },
  msgAuthor: { color: colors.accent, fontSize: 11, fontWeight: '800', marginBottom: 1 },
  msgBody: { color: '#fff', fontSize: 15, paddingRight: 3 },
  msgTime: { color: 'rgba(255,255,255,0.6)', fontSize: 10, alignSelf: 'flex-end', marginTop: 1 },
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
