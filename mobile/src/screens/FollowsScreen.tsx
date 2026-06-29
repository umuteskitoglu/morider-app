import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { RouteProp, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { LinearGradient } from 'expo-linear-gradient';

import { Card, EmptyState } from '../components/ui';
import FollowButton from '../components/FollowButton';
import { useAuth } from '../store/auth';
import { ProfileStackParams } from '../navigation/RootNavigator';
import { api } from '../api/client';
import { colors, gradients, radius, spacing } from '../theme';

// `following` reports whether the *caller* follows this user — drives the row's
// button regardless of whose list is being viewed.
type FollowUser = { id: number; name: string; email: string; following: boolean };
type Tab = 'following' | 'followers';

export default function FollowsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ProfileStackParams>>();
  const route = useRoute<RouteProp<ProfileStackParams, 'Follows'>>();
  const { user } = useAuth();
  // No userId → the caller's own follows; otherwise that user's lists.
  const targetId = route.params?.userId;
  const targetName = route.params?.name;
  const isSelf = targetId == null;

  const [tab, setTab] = useState<Tab>(route.params?.tab ?? 'following');
  const [following, setFollowing] = useState<FollowUser[]>([]);
  const [followers, setFollowers] = useState<FollowUser[]>([]);
  // ids the caller currently follows — drives each row's button state.
  const [followedIds, setFollowedIds] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    if (targetName) navigation.setOptions({ title: targetName });
  }, [navigation, targetName]);

  const load = useCallback(async () => {
    try {
      const base = isSelf ? '/api/follows' : `/api/follows/${targetId}`;
      const [fl, fr] = await Promise.all([
        api.get(`${base}/following`),
        api.get(`${base}/followers`),
      ]);
      const flUsers: FollowUser[] = fl.data.users ?? [];
      const frUsers: FollowUser[] = fr.data.users ?? [];
      setFollowing(flUsers);
      setFollowers(frUsers);
      // Seed from the server's `following` flag across both lists.
      setFollowedIds(new Set([...flUsers, ...frUsers].filter((u) => u.following).map((u) => u.id)));
    } catch {
      // ignore (e.g. 403 when not connected — lists simply stay empty)
    }
  }, [isSelf, targetId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  function onToggle(id: number, isFollowing: boolean) {
    setFollowedIds((prev) => {
      const next = new Set(prev);
      if (isFollowing) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const list = tab === 'following' ? following : followers;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <View style={styles.tabs}>
        <TabButton
          label={`${isSelf ? 'Takip Ettiklerim' : 'Takip Edilenler'} (${following.length})`}
          active={tab === 'following'}
          onPress={() => setTab('following')}
        />
        <TabButton
          label={`${isSelf ? 'Takipçilerim' : 'Takipçiler'} (${followers.length})`}
          active={tab === 'followers'}
          onPress={() => setTab('followers')}
        />
      </View>

      {list.length === 0 ? (
        <EmptyState
          icon={tab === 'following' ? 'account-heart-outline' : 'account-group-outline'}
          title={tab === 'following' ? 'Takip yok' : 'Takipçi yok'}
          hint={
            tab === 'following'
              ? isSelf
                ? 'Keşfet veya profillerden motorcuları takip et!'
                : 'Henüz kimseyi takip etmiyor.'
              : isSelf
                ? 'Henüz seni takip eden yok.'
                : 'Henüz takipçisi yok.'
          }
        />
      ) : (
        list.map((u) => (
          <Card key={u.id} style={styles.row}>
            <Pressable
              style={styles.rowTap}
              onPress={() => navigation.navigate('UserProfile', { userId: u.id, name: u.name })}
            >
              <Avatar name={u.name} />
              <View style={styles.info}>
                <Text style={styles.name}>{u.name}</Text>
                <Text style={styles.email}>{u.email}</Text>
              </View>
            </Pressable>
            {u.id !== user?.id && (
              <FollowButton
                userId={u.id}
                following={followedIds.has(u.id)}
                onChange={(f) => onToggle(u.id, f)}
                compact
              />
            )}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <LinearGradient colors={gradients.primary} style={styles.avatar}>
      <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  tabs: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.surfaceAlt, borderColor: colors.primary },
  tabText: { color: colors.textMuted, fontWeight: '800', fontSize: 13 },
  tabTextActive: { color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  info: { flex: 1 },
  name: { color: colors.text, fontWeight: '800' },
  email: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900' },
});
