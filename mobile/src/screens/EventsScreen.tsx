import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EventsStackParams } from '../navigation/RootNavigator';
import { Button, Card, EmptyState, TextField, TouchCard } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { eventDraft } from '../lib/eventDraft';
import { formatDateTime } from '../lib/datetime';
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

export default function EventsScreen({ navigation }: Props) {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');

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
            <Text style={styles.sectionTitle}>Yaklaşan etkinlikler</Text>
          </View>
        }
        ListEmptyComponent={
          !loading ? (
            <EmptyState icon="calendar-blank" title="Henüz etkinlik yok" hint="Bir sürüş planla ve arkadaşlarını davet et!" />
          ) : null
        }
        renderItem={({ item }) => (
          <TouchCard onPress={() => navigation.navigate('EventDetail', { code: item.code })} style={styles.card}>
              <View style={styles.iconBadge}>
                <MaterialCommunityIcons name="calendar-clock" size={22} color={colors.primary} />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.name} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.meta}>
                  <MaterialCommunityIcons name="map-marker-account" size={12} color={colors.textMuted} />
                  {` Buluşma: ${formatDateTime(item.meet_at)}`}
                </Text>
                <View style={styles.badges}>
                  <View style={styles.goingBadge}>
                    <MaterialCommunityIcons name="account-check" size={12} color={colors.success} />
                    <Text style={styles.goingText}>{item.going_count} geliyor</Text>
                  </View>
                  {item.is_host ? (
                    <View style={styles.hostBadge}>
                      <Text style={styles.hostText}>Düzenleyen</Text>
                    </View>
                  ) : item.my_rsvp ? (
                    <View style={[styles.rsvpBadge, { borderColor: RSVP_COLOR[item.my_rsvp] }]}>
                      <Text style={[styles.rsvpText, { color: RSVP_COLOR[item.my_rsvp] }]}>{RSVP_LABEL[item.my_rsvp]}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
          </TouchCard>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  header: { gap: spacing.md },
  joinCard: { gap: spacing.sm },
  joinTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
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
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(255,106,26,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 17, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 13 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  goingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  goingText: { color: colors.success, fontSize: 12, fontWeight: '700' },
  hostBadge: { backgroundColor: 'rgba(255,106,26,0.14)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  hostText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  rsvpBadge: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  rsvpText: { fontSize: 11, fontWeight: '800' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
});
