import React, { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Card } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type Ride = {
  id: number;
  distance: number;
  avg_speed: number;
  elevation_gain: number;
  start_time: string | null;
};

export default function RidesScreen() {
  const [rides, setRides] = useState<Ride[]>([]);
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
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={rides}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyWrap}>
              <MaterialCommunityIcons name="motorbike" size={48} color={colors.border} />
              <Text style={styles.empty}>{error ?? 'Henüz sürüş yok.\nİlk sürüşünü kaydet!'}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <View style={styles.cardHead}>
              <View style={styles.distanceWrap}>
                <MaterialCommunityIcons name="motorbike" size={20} color={colors.primary} />
                <Text style={styles.distance}>{item.distance.toFixed(2)} km</Text>
              </View>
              <Text style={styles.date}>{item.start_time ? item.start_time.slice(0, 10) : '-'}</Text>
            </View>
            <View style={styles.row}>
              <Meta icon="speedometer" label="Ort. hız" value={`${item.avg_speed.toFixed(0)} km/s`} />
              <Meta icon="image-filter-hdr" label="Yükseklik" value={`${item.elevation_gain.toFixed(0)} m`} />
            </View>
          </Card>
        )}
      />
    </View>
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
  metaLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
});
