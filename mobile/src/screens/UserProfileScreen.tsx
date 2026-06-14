import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PostDetail, DetailPost } from '../components/PostDetail';
import { AvatarViewer } from '../components/AvatarViewer';
import FollowButton from '../components/FollowButton';
import { useAuth } from '../store/auth';
import { api, apiBaseURL } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Badge = { id: number; type: string; description: string };

// Stack-agnostic props: this screen is registered in both the Feed and Profile
// stacks. It only needs the route params and setOptions, so we avoid binding it
// to a single navigator's param list.
type Props = {
  route: RouteProp<{ UserProfile: { userId: number; name: string } }, 'UserProfile'>;
  navigation: { setOptions: (opts: { title?: string }) => void };
};

export default function UserProfileScreen({ route, navigation }: Props) {
  const { userId, name } = route.params;
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [posts, setPosts] = useState<DetailPost[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [viewer, setViewer] = useState<DetailPost | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [following, setFollowing] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [stats, setStats] = useState({ postCount: 0, followerCount: 0, followingCount: 0 });
  const [zoomUri, setZoomUri] = useState<string | null>(null);

  const isSelf = user?.id === userId;

  const thumb = (width - spacing.md * 2 - spacing.xs * 2) / 3;

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    try {
      const reqs: Promise<any>[] = [
        api.get(`/api/users/${userId}`),
        api.get(`/api/feed/user/${userId}`),
        api.get(`/api/rewards/user/${userId}`),
      ];
      if (!isSelf) reqs.push(api.get(`/api/follows/status/${userId}`));
      const [u, p, b, s] = await Promise.all(reqs);
      setAvatarUrl(u.data.avatar_url ?? '');
      setUsername(u.data.username ?? '');
      setBio(u.data.bio ?? '');
      setStats({
        postCount: u.data.post_count ?? 0,
        followerCount: u.data.follower_count ?? 0,
        followingCount: u.data.following_count ?? 0,
      });
      setPosts(p.data.posts ?? []);
      setBadges(b.data.rewards ?? []);
      if (s) setFollowing(s.data.following ?? false);
    } catch {
      // ignore
    }
  }, [userId, isSelf]);

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

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <LinearGradient colors={gradients.surface} style={styles.header}>
          {avatarUrl ? (
            <Pressable onPress={() => setZoomUri(apiBaseURL() + avatarUrl)}>
              <Image source={{ uri: apiBaseURL() + avatarUrl }} style={styles.avatar} />
            </Pressable>
          ) : (
            <LinearGradient colors={gradients.primary} style={styles.avatar}>
              <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
            </LinearGradient>
          )}
          <Text style={styles.name}>{name}</Text>
          {username ? <Text style={styles.handle}>@{username}</Text> : null}
          {bio ? <Text style={styles.bio}>{bio}</Text> : null}

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statNum}>{stats.postCount}</Text>
              <Text style={styles.statLabel}>Gönderi</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statNum}>{stats.followerCount}</Text>
              <Text style={styles.statLabel}>Takipçi</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statNum}>{stats.followingCount}</Text>
              <Text style={styles.statLabel}>Takip</Text>
            </View>
          </View>
          {badges.length > 0 && (
            <View style={styles.badges}>
              {badges.map((b) => (
                <View key={b.id} style={styles.chip}>
                  <Text style={styles.chipIcon}>🏅</Text>
                  <Text style={styles.chipText}>{b.description || b.type}</Text>
                </View>
              ))}
            </View>
          )}
        </LinearGradient>

        {!isSelf && (
          <FollowButton
            userId={userId}
            following={following}
            onChange={(next) => {
              setFollowing(next);
              setStats((s) => ({ ...s, followerCount: Math.max(0, s.followerCount + (next ? 1 : -1)) }));
            }}
          />
        )}

        {posts.length === 0 ? (
          <Text style={styles.empty}>Bu kullanıcının henüz paylaşımı yok.</Text>
        ) : (
          <View style={styles.grid}>
            {posts.map((p) => (
              <Pressable key={p.id} style={[styles.gridItem, { width: thumb, height: thumb }]} onPress={() => setViewer(p)}>
                <Image source={{ uri: apiBaseURL() + p.photos[0] }} style={styles.gridImg} />
                {p.photos.length > 1 && (
                  <View style={styles.multi}>
                    <MaterialCommunityIcons name="image-multiple" size={14} color="#fff" />
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
      <PostDetail post={viewer} onClose={() => setViewer(null)} />
      <AvatarViewer uri={zoomUri} onClose={() => setZoomUri(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  header: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  avatar: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm, ...shadow.glow },
  avatarText: { color: '#fff', fontSize: 34, fontWeight: '900' },
  name: { color: colors.text, fontSize: 22, fontWeight: '900' },
  handle: { color: colors.primary, fontWeight: '700', marginTop: 2 },
  muted: { color: colors.textMuted, marginTop: 2 },
  bio: { color: colors.text, textAlign: 'center', marginTop: spacing.sm, paddingHorizontal: spacing.lg, lineHeight: 19 },
  statsRow: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    justifyContent: 'space-around',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  statItem: { alignItems: 'center', gap: 2, flex: 1 },
  statNum: { color: colors.text, fontWeight: '900', fontSize: 18 },
  statLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 999,
  },
  chipIcon: { fontSize: 13 },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  gridItem: { borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  gridImg: { width: '100%', height: '100%' },
  multi: { position: 'absolute', top: 4, right: 4 },
});
