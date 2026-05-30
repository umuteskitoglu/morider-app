import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { RoutesStackParams } from '../navigation/RootNavigator';
import { Card, Stars } from '../components/ui';
import FollowButton from '../components/FollowButton';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type PublicRoute = {
  id: number;
  user_id: number;
  name: string;
  description: string;
  distance: number;
  owner_name: string;
  avg_rating: number;
  rating_count: number;
  i_follow: boolean;
};
type Props = NativeStackScreenProps<RoutesStackParams, 'Explore'>;

export default function ExploreScreen({ navigation }: Props) {
  const [routes, setRoutes] = useState<PublicRoute[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await api.get('/api/routes/explore');
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
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyWrap}>
              <MaterialCommunityIcons name="compass-outline" size={48} color={colors.border} />
              <Text style={styles.empty}>{error ?? 'Henüz herkese açık rota yok.\nİlk paylaşan sen ol!'}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('RouteDetail', { id: item.id, name: item.name })}>
            <Card style={styles.card}>
              <View style={styles.iconBadge}>
                <MaterialCommunityIcons name="earth" size={22} color={colors.primary} />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <View style={styles.ownerRow}>
                  <MaterialCommunityIcons name="account-circle-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.owner} numberOfLines={1}>{item.owner_name}</Text>
                  <FollowButton
                    userId={item.user_id}
                    following={item.i_follow}
                    onChange={(f) =>
                      setRoutes((prev) =>
                        prev.map((r) => (r.user_id === item.user_id ? { ...r, i_follow: f } : r)),
                      )
                    }
                    compact
                  />
                </View>
                <View style={styles.metaRow}>
                  <Text style={styles.distance}>{item.distance.toFixed(2)} km</Text>
                  {item.rating_count > 0 ? <Stars value={item.avg_rating} count={item.rating_count} size={14} /> : null}
                </View>
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
  ownerRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  owner: { color: colors.textMuted, fontSize: 13, flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  distance: { color: colors.primary, fontWeight: '800' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
});
