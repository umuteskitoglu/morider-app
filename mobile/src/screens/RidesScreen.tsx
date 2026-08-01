import React, { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Card, EmptyState } from '../components/ui';
import { useCachedState } from '../lib/offlineCache';
import { useConnectivity } from '../store/connectivity';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Ride = {
  id: number;
  distance: number;
  max_speed: number | null;
  start_time: string | null;
  end_time: string | null;
};

// fmtRideDuration renders the ride's wall-clock length as "1s 24dk" / "37dk".
function fmtRideDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

export default function RidesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ProfileStackParams>>();
  const { online } = useConnectivity();
  // A rider's own history is the least volatile thing in the app; there is no
  // reason for it to disappear at the bottom of a valley.
  const [rides, setRides] = useCachedState<Ride[]>('rides', []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await api.get('/api/rides');
      setRides(data.rides ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [setRides]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const remove = useCallback((item: Ride, close: () => void) => {
    const label = item.start_time ? item.start_time.slice(0, 10) : `${item.distance.toFixed(2)} km`;
    Alert.alert('Sürüşü sil', `"${label}" sürüşü silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel', onPress: close },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/rides/${item.id}`);
            setRides(rides.filter((r) => r.id !== item.id));
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
            close();
          }
        },
      },
    ]);
  }, [rides, setRides]);

  return (
    <View style={styles.container}>
      <FlatList
        data={rides}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListEmptyComponent={
          !loading ? (
            <EmptyState
              icon={online ? 'motorbike' : 'wifi-off'}
              title={online ? error ?? 'Henüz sürüş yok' : 'Çevrimdışısın'}
              hint={
                online
                  ? error
                    ? undefined
                    : 'İlk sürüşünü kaydet ve istatistiklerini gör!'
                  : 'Bağlantı gelince sürüşlerin burada olacak.'
              }
            />
          ) : null
        }
        renderItem={({ item }) => (
          <RideRow item={item} onOpen={() => navigation.navigate('RideDetail', { id: item.id })} onDelete={remove} />
        )}
      />
    </View>
  );
}

function RideRow({
  item,
  onOpen,
  onDelete,
}: {
  item: Ride;
  onOpen: () => void;
  onDelete: (item: Ride, close: () => void) => void;
}) {
  const ref = useRef<Swipeable>(null);

  // Red "Sil" panel revealed by swiping the row left.
  const renderRightActions = () => (
    <Pressable style={styles.deleteAction} onPress={() => onDelete(item, () => ref.current?.close())}>
      <MaterialCommunityIcons name="trash-can-outline" size={24} color="#fff" />
      <Text style={styles.deleteText}>Sil</Text>
    </Pressable>
  );

  return (
    <Swipeable ref={ref} renderRightActions={renderRightActions} overshootRight={false} rightThreshold={40}>
      <Pressable onPress={onOpen}>
        <Card style={styles.card}>
          <View style={styles.cardHead}>
            <View style={styles.distanceWrap}>
              <MaterialCommunityIcons name="motorbike" size={20} color={colors.primary} />
              <Text style={styles.distance}>{item.distance.toFixed(2)} km</Text>
            </View>
            <Text style={styles.date}>{item.start_time ? item.start_time.slice(0, 10) : '-'}</Text>
          </View>
          <View style={styles.row}>
            <Meta icon="speedometer" label="Max hız" value={item.max_speed != null ? `${item.max_speed.toFixed(0)} km/s` : '—'} />
            <Meta icon="timer-outline" label="Süre" value={fmtRideDuration(item.start_time, item.end_time)} />
          </View>
        </Card>
      </Pressable>
    </Swipeable>
  );
}

function Meta({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.meta}>
      <MaterialCommunityIcons name={icon} size={16} color={colors.textMuted} />
      <View>
        <Text style={styles.metaValue}>{value}</Text>
        <Text style={styles.metaLabel}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  card: { gap: spacing.md },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  distanceWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  distance: { color: colors.text, fontSize: 22, fontWeight: '900' },
  date: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', gap: spacing.xl },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  metaValue: { color: colors.text, fontWeight: '800' },
  metaLabel: { color: colors.textMuted, fontSize: 12, letterSpacing: 0.5 },
  deleteAction: {
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'center',
    width: 84,
    borderRadius: radius.md,
    marginLeft: spacing.sm,
    gap: 2,
  },
  deleteText: { color: '#fff', fontWeight: '800', fontSize: 12 },
});
