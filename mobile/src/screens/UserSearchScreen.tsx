import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, SectionList, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { FeedStackParams } from '../navigation/RootNavigator';
import { LinearGradient } from 'expo-linear-gradient';

import { EmptyState, Stars, TextField, TouchCard } from '../components/ui';
import FollowButton from '../components/FollowButton';
import { api, apiBaseURL } from '../api/client';
import { colors, gradients, spacing } from '../theme';

type UserResult = { id: number; name: string; avatar_url: string; following: boolean };
type RouteResult = {
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
type Props = NativeStackScreenProps<FeedStackParams, 'UserSearch'>;

// A section holds either users or routes; the `kind` tag drives which row
// renderer runs, since SectionList mixes both item shapes in one list.
type Section =
  | { kind: 'users'; title: string; data: UserResult[] }
  | { kind: 'routes'; title: string; data: RouteResult[] };

export default function UserSearchScreen({ navigation }: Props) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserResult[]>([]);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [loading, setLoading] = useState(false);
  // ids the caller currently follows — drives each user row's button state.
  const [followedIds, setFollowedIds] = useState<Set<number>>(new Set());
  // Guards against a slow request overwriting a newer one's results.
  const reqId = useRef(0);

  const search = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setUsers([]);
      setRoutes([]);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    try {
      // Fire both searches together so results land in one render pass.
      const [uRes, rRes] = await Promise.all([
        api.get('/api/users/search', { params: { q: trimmed } }),
        api.get('/api/routes/search', { params: { q: trimmed } }),
      ]);
      if (id !== reqId.current) return; // a newer search superseded this one
      const foundUsers: UserResult[] = uRes.data.users ?? [];
      setUsers(foundUsers);
      setRoutes(rRes.data.routes ?? []);
      setFollowedIds(new Set(foundUsers.filter((u) => u.following).map((u) => u.id)));
    } catch {
      if (id === reqId.current) {
        setUsers([]);
        setRoutes([]);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // Debounce queries so we don't fire a request on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => search(q), 300);
    return () => clearTimeout(t);
  }, [q, search]);

  function onToggleFollow(id: number, isFollowing: boolean) {
    setFollowedIds((prev) => {
      const next = new Set(prev);
      if (isFollowing) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const sections: Section[] = [];
  if (users.length) sections.push({ kind: 'users', title: 'Kişiler', data: users });
  if (routes.length) sections.push({ kind: 'routes', title: 'Rotalar', data: routes });

  const short = q.trim().length < 2;

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <TextField
          icon="magnify"
          placeholder="Kişi veya rota ara"
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <SectionList<UserResult | RouteResult, Section>
        sections={sections}
        keyExtractor={(item, index) => `${item.id}-${index}`}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{(section as Section).title}</Text>
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : short ? (
            <EmptyState icon="magnify" title="Kişi veya rota bul" hint="En az 2 harf yazarak motorcu arkadaşlarını ve rotaları ara." />
          ) : (
            <EmptyState icon="magnify-close" title="Eşleşen sonuç bulunamadı" />
          )
        }
        renderItem={({ item, section }) =>
          (section as Section).kind === 'users' ? (
            <UserRow
              user={item as UserResult}
              following={followedIds.has((item as UserResult).id)}
              onPress={() => navigation.navigate('UserProfile', { userId: (item as UserResult).id, name: (item as UserResult).name })}
              onToggle={onToggleFollow}
            />
          ) : (
            <RouteRow
              route={item as RouteResult}
              onPress={() => navigation.navigate('RouteDetail', { id: (item as RouteResult).id, name: (item as RouteResult).name })}
            />
          )
        }
      />
    </View>
  );
}

function UserRow({
  user,
  following,
  onPress,
  onToggle,
}: {
  user: UserResult;
  following: boolean;
  onPress: () => void;
  onToggle: (id: number, following: boolean) => void;
}) {
  return (
    <TouchCard onPress={onPress} style={styles.userRow}>
      <Avatar name={user.name} url={user.avatar_url} />
      <View style={styles.info}>
        <Text style={styles.name}>{user.name}</Text>
      </View>
      <FollowButton userId={user.id} following={following} onChange={(f) => onToggle(user.id, f)} compact />
    </TouchCard>
  );
}

function RouteRow({ route, onPress }: { route: RouteResult; onPress: () => void }) {
  return (
    <TouchCard onPress={onPress} style={styles.routeRow}>
      <View style={styles.iconBadge}>
        <MaterialCommunityIcons name="map-marker-path" size={22} color={colors.primary} />
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{route.name}</Text>
        <View style={styles.ownerRow}>
          <MaterialCommunityIcons name="account-circle-outline" size={14} color={colors.textMuted} />
          <Text style={styles.owner} numberOfLines={1}>{route.owner_name}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.distance}>{route.distance.toFixed(2)} km</Text>
          {route.rating_count > 0 ? <Stars value={route.avg_rating} count={route.rating_count} size={14} /> : null}
        </View>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
    </TouchCard>
  );
}

function Avatar({ name, url }: { name: string; url: string }) {
  if (url) {
    return <Image source={{ uri: `${apiBaseURL()}${url}` }} style={styles.avatar} />;
  }
  return (
    <LinearGradient colors={gradients.primary} style={styles.avatar}>
      <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl, flexGrow: 1 },
  spinner: { marginTop: spacing.lg },
  sectionHeader: {
    color: colors.textMuted,
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 0.5,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  info: { flex: 1 },
  name: { color: colors.text, fontWeight: '800' },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(255,106,26,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  owner: { color: colors.textMuted, fontSize: 13, flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  distance: { color: colors.primary, fontWeight: '800' },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '900' },
});
