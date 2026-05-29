import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { RoutesStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type RouteItem = { id: number; name: string; description: string; distance: number };
type Props = NativeStackScreenProps<RoutesStackParams, 'RoutesList'>;

export default function RoutesScreen({ navigation }: Props) {
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await api.get('/api/routes');
      setRoutes(data.routes ?? []);
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
        data={routes}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListHeaderComponent={<Button title="Yeni Rota" icon="plus" onPress={() => navigation.navigate('RouteCreate')} />}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyWrap}>
              <MaterialCommunityIcons name="map-marker-path" size={48} color={colors.border} />
              <Text style={styles.empty}>{error ?? 'Henüz rota yok.\nYeni bir rota oluştur!'}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('RouteDetail', { id: item.id, name: item.name })}>
            <Card style={styles.card}>
              <View style={styles.iconBadge}>
                <MaterialCommunityIcons name="map-marker-path" size={22} color={colors.primary} />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                {item.description ? <Text style={styles.desc} numberOfLines={1}>{item.description}</Text> : null}
                <Text style={styles.distance}>{item.distance.toFixed(2)} km</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(255,90,31,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1 },
  name: { color: colors.text, fontSize: 17, fontWeight: '800' },
  distance: { color: colors.primary, fontWeight: '800', marginTop: 2 },
  desc: { color: colors.textMuted, fontSize: 13 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
});
