import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Card } from '../components/ui';
import FollowButton from '../components/FollowButton';
import { api } from '../api/client';
import { colors, radius, spacing } from '../theme';

type FollowUser = { id: number; name: string; email: string };
type Tab = 'following' | 'followers';

export default function FollowsScreen() {
  const [tab, setTab] = useState<Tab>('following');
  const [following, setFollowing] = useState<FollowUser[]>([]);
  const [followers, setFollowers] = useState<FollowUser[]>([]);
  // ids the caller currently follows — drives each row's button state.
  const [followedIds, setFollowedIds] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [fl, fr] = await Promise.all([
        api.get('/api/follows/following'),
        api.get('/api/follows/followers'),
      ]);
      const flUsers: FollowUser[] = fl.data.users ?? [];
      setFollowing(flUsers);
      setFollowers(fr.data.users ?? []);
      setFollowedIds(new Set(flUsers.map((u) => u.id)));
    } catch {
      // ignore
    }
  }, []);

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
        <TabButton label={`Takip Ettiklerim (${following.length})`} active={tab === 'following'} onPress={() => setTab('following')} />
        <TabButton label={`Takipçilerim (${followers.length})`} active={tab === 'followers'} onPress={() => setTab('followers')} />
      </View>

      {list.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            {tab === 'following'
              ? 'Henüz kimseyi takip etmiyorsun. Keşfet veya profillerden takip et!'
              : 'Henüz seni takip eden yok.'}
          </Text>
        </Card>
      ) : (
        list.map((u) => (
          <Card key={u.id} style={styles.row}>
            <Avatar name={u.name} />
            <View style={styles.info}>
              <Text style={styles.name}>{u.name}</Text>
              <Text style={styles.email}>{u.email}</Text>
            </View>
            <FollowButton
              userId={u.id}
              following={followedIds.has(u.id)}
              onChange={(f) => onToggle(u.id, f)}
              compact
            />
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
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
    </View>
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
  info: { flex: 1 },
  name: { color: colors.text, fontWeight: '800' },
  email: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900' },
});
