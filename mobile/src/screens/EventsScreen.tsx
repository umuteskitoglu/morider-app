import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EventsStackParams } from '../navigation/RootNavigator';
import { Button, Card, EmptyState, TextField, TouchCard } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { eventDraft } from '../lib/eventDraft';
import { dayLabel, formatDateTime, formatTime, timeUntil } from '../lib/datetime';
import { colors, radius, spacing } from '../theme';

type EventItem = {
  event_id: number;
  code: string;
  title: string;
  host_id: number;
  meet_at: string;
  start_at: string;
  status: string;
  my_rsvp: string;
  going_count: number;
  is_host: boolean;
};

type Props = NativeStackScreenProps<EventsStackParams, 'EventsList'>;

const RSVP_LABEL: Record<string, string> = { going: 'Geliyorsun', maybe: 'Belki', declined: 'Gelmiyorsun' };
const RSVP_COLOR: Record<string, string> = { going: colors.success, maybe: colors.accent, declined: colors.textMuted };

// Short Turkish month labels for the calendar tile on each event card.
const MONTHS = ['OCA', 'ŞUB', 'MAR', 'NİS', 'MAY', 'HAZ', 'TEM', 'AĞU', 'EYL', 'EKİ', 'KAS', 'ARA'];

const INTRO_SEEN_KEY = 'morider.events.introSeen';

// The three-step "what is an event?" explainer. Shown until dismissed; the ?
// button next to the section title brings it back.
function IntroCard({ onClose }: { onClose: () => void }) {
  const steps: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; title: string; text: string }[] = [
    { icon: 'calendar-plus', title: 'Planla', text: 'Buluşma yerini ve saatini belirle, istersen rota ekle.' },
    { icon: 'share-variant', title: 'Davet et', text: '6 haneli kodu arkadaşlarına gönder; kim geliyor anında gör.' },
    { icon: 'motorbike', title: 'Birlikte sür', text: 'Vakti gelince etkinlik tek dokunuşla canlı grup sürüşüne dönüşür — herkesi haritada izle.' },
  ];
  return (
    <Card style={styles.introCard}>
      <View style={styles.introHeader}>
        <View style={styles.introTitleRow}>
          <MaterialCommunityIcons name="lightbulb-on-outline" size={18} color={colors.accent} />
          <Text style={styles.introTitle}>Etkinlik nedir?</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10}>
          <MaterialCommunityIcons name="close" size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      <Text style={styles.introLead}>Arkadaşlarınla grup sürüşü planlamanın en kolay yolu:</Text>
      {steps.map((s, i) => (
        <View key={s.title} style={styles.introStep}>
          <View style={styles.introStepIcon}>
            <MaterialCommunityIcons name={s.icon} size={18} color={colors.primary} />
          </View>
          <View style={styles.introStepBody}>
            <Text style={styles.introStepTitle}>{`${i + 1}. ${s.title}`}</Text>
            <Text style={styles.introStepText}>{s.text}</Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

export default function EventsScreen({ navigation }: Props) {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');
  // null = not decided yet (avoid flashing the card before AsyncStorage answers)
  const [showIntro, setShowIntro] = useState<boolean | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(INTRO_SEEN_KEY)
      .then((v) => setShowIntro(v == null))
      .catch(() => setShowIntro(false));
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/api/events');
      setEvents(data.events ?? []);
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function dismissIntro() {
    setShowIntro(false);
    AsyncStorage.setItem(INTRO_SEEN_KEY, '1').catch(() => {});
  }

  function joinByCode() {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setCode('');
    navigation.navigate('EventDetail', { code: c });
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={events}
        keyExtractor={(item) => String(item.event_id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            {showIntro === true && <IntroCard onClose={dismissIntro} />}
            <Button
              title="Yeni Etkinlik"
              icon="calendar-plus"
              onPress={() => {
                eventDraft.reset();
                navigation.navigate('EventCreate');
              }}
            />
            <Card style={styles.joinCard}>
              <Text style={styles.joinTitle}>Kodla katıl</Text>
              <Text style={styles.joinHint}>Arkadaşının paylaştığı 6 haneli davet kodunu gir.</Text>
              <View style={styles.joinRow}>
                <View style={styles.joinField}>
                  <TextField
                    icon="key-variant"
                    value={code}
                    onChangeText={setCode}
                    autoCapitalize="characters"
                    placeholder="ABC123"
                    maxLength={6}
                  />
                </View>
                <Pressable style={styles.joinBtn} onPress={joinByCode} hitSlop={6}>
                  <MaterialCommunityIcons name="arrow-right" size={22} color="#fff" />
                </Pressable>
              </View>
            </Card>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Yaklaşan etkinlikler</Text>
              <Pressable onPress={() => setShowIntro(true)} hitSlop={10}>
                <MaterialCommunityIcons name="help-circle-outline" size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={
          !loading ? (
            <EmptyState
              icon="calendar-blank"
              title="Henüz etkinlik yok"
              hint={'Bir sürüş planla, kodu arkadaşlarına gönder.\nSürüş günü etkinlik canlı grup sürüşüne dönüşür.'}
            />
          ) : null
        }
        renderItem={({ item }) => {
          const meet = new Date(item.meet_at);
          const dl = dayLabel(meet);
          const remaining = timeUntil(meet);
          const meetLabel = dl ? `${dl} ${formatTime(meet)}` : formatDateTime(meet);
          const needsRsvp = !item.is_host && !item.my_rsvp;
          return (
            <TouchCard onPress={() => navigation.navigate('EventDetail', { code: item.code })} style={styles.card}>
              <View style={styles.dateTile}>
                <Text style={styles.dateTileDay}>{meet.getDate()}</Text>
                <Text style={styles.dateTileMonth}>{MONTHS[meet.getMonth()]}</Text>
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.name} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.meta}>
                  <MaterialCommunityIcons name="map-marker-account" size={12} color={colors.textMuted} />
                  {` ${meetLabel} buluşma · ${formatTime(item.start_at)} kalkış`}
                </Text>
                <View style={styles.badges}>
                  {remaining ? (
                    <View style={[styles.timeBadge, dl === 'Bugün' && styles.timeBadgeToday]}>
                      <MaterialCommunityIcons
                        name="clock-outline"
                        size={12}
                        color={dl === 'Bugün' ? colors.primary : colors.textMuted}
                      />
                      <Text style={[styles.timeBadgeText, dl === 'Bugün' && styles.timeBadgeTextToday]}>
                        {`${remaining} kaldı`}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.timeBadge}>
                      <MaterialCommunityIcons name="clock-alert-outline" size={12} color={colors.textMuted} />
                      <Text style={styles.timeBadgeText}>Buluşma geçti</Text>
                    </View>
                  )}
                  <View style={styles.goingBadge}>
                    <MaterialCommunityIcons name="account-check" size={12} color={colors.success} />
                    <Text style={styles.goingText}>{item.going_count} geliyor</Text>
                  </View>
                  {item.is_host ? (
                    <View style={styles.hostBadge}>
                      <Text style={styles.hostText}>Düzenleyen</Text>
                    </View>
                  ) : needsRsvp ? (
                    <View style={styles.needRsvpBadge}>
                      <Text style={styles.needRsvpText}>Yanıt bekliyor</Text>
                    </View>
                  ) : (
                    <View style={[styles.rsvpBadge, { borderColor: RSVP_COLOR[item.my_rsvp] }]}>
                      <Text style={[styles.rsvpText, { color: RSVP_COLOR[item.my_rsvp] }]}>{RSVP_LABEL[item.my_rsvp]}</Text>
                    </View>
                  )}
                </View>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
            </TouchCard>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  header: { gap: spacing.md },
  introCard: { gap: spacing.sm, borderColor: 'rgba(255,176,32,0.35)' },
  introHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  introTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  introTitle: { color: colors.text, fontSize: 16, fontWeight: '900' },
  introLead: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  introStep: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  introStepIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: 'rgba(255,106,26,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  introStepBody: { flex: 1, gap: 1 },
  introStepTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  introStepText: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  joinCard: { gap: spacing.xs },
  joinTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  joinHint: { color: colors.textFaint, fontSize: 12, marginBottom: spacing.xs },
  joinRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  joinField: { flex: 1 },
  joinBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dateTile: {
    width: 48,
    height: 52,
    borderRadius: 14,
    backgroundColor: 'rgba(255,106,26,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateTileDay: { color: colors.primary, fontSize: 19, fontWeight: '900', lineHeight: 22 },
  dateTileMonth: { color: colors.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  cardBody: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 17, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 13 },
  badges: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: 2 },
  timeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timeBadgeToday: {
    backgroundColor: 'rgba(255,106,26,0.14)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  timeBadgeText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  timeBadgeTextToday: { color: colors.primary },
  goingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  goingText: { color: colors.success, fontSize: 12, fontWeight: '700' },
  hostBadge: { backgroundColor: 'rgba(255,106,26,0.14)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  hostText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  needRsvpBadge: {
    backgroundColor: 'rgba(255,176,32,0.14)',
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  needRsvpText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  rsvpBadge: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  rsvpText: { fontSize: 12, fontWeight: '800' },
});
