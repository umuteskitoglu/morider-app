import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { RouteProp, useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PostDetail, DetailPost } from '../components/PostDetail';
import { AvatarViewer } from '../components/AvatarViewer';
import FollowButton from '../components/FollowButton';
import { CreateChallengeModal } from '../components/CreateChallengeModal';
import { Button } from '../components/ui';
import { tierMeta } from '../lib/rewards';
import { useAuth } from '../store/auth';
import { RiderChips } from '../components/RiderChips';
import { ProfileStackParams } from '../navigation/RootNavigator';
import { api, apiBaseURL } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Badge = { id: number; type: string; description: string; tier?: string };
type PublicMoto = { id: number; name: string; year: number };
type PublicRoute = { id: number; name: string; distance: number };

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
  // Separate, fully-typed nav handle for pushing onto the stack (the screen's
  // own `navigation` prop is narrowed to setOptions). Both stacks that host this
  // screen declare an identical `Follows` route, so this typing holds at runtime.
  const stackNav = useNavigation<NativeStackNavigationProp<ProfileStackParams>>();
  const { width } = useWindowDimensions();
  const [posts, setPosts] = useState<DetailPost[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [garage, setGarage] = useState<PublicMoto[]>([]);
  const [routes, setRoutes] = useState<PublicRoute[]>([]);
  const [viewer, setViewer] = useState<DetailPost | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followedBy, setFollowedBy] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [stats, setStats] = useState({ postCount: 0, followerCount: 0, followingCount: 0 });
  const [licenseType, setLicenseType] = useState('');
  const [bikeType, setBikeType] = useState('');
  const [zoomUri, setZoomUri] = useState<string | null>(null);
  const [challengeOpen, setChallengeOpen] = useState(false);

  const isSelf = user?.id === userId;
  // Instagram-style: follow lists open only when there's a connection — you
  // follow them, or they follow you (your own profile is always open). The
  // backend enforces the same rule; this just gates the tap affordance.
  const canViewFollows = isSelf || following || followedBy;

  function openFollows(tab: 'following' | 'followers') {
    if (!canViewFollows) return;
    stackNav.navigate('Follows', { userId, name, tab });
  }

  const thumb = (width - spacing.md * 2 - spacing.xs * 2) / 3;

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    // Each section loads independently: one failing endpoint (e.g. an older
    // backend missing a route) must not blank the whole profile. settle()
    // swallows the error and yields null so the rest still renders.
    const settle = async (p: Promise<any>): Promise<any | null> => {
      try {
        return await p;
      } catch {
        return null;
      }
    };
    const [u, p, b, g, r, s] = await Promise.all([
      settle(api.get(`/api/users/${userId}`)),
      settle(api.get(`/api/feed/user/${userId}`)),
      settle(api.get(`/api/rewards/user/${userId}`)),
      settle(api.get(`/api/garage/user/${userId}`)),
      settle(api.get(`/api/routes/user/${userId}`)),
      isSelf ? Promise.resolve(null) : settle(api.get(`/api/follows/status/${userId}`)),
    ]);
    if (u) {
      setAvatarUrl(u.data.avatar_url ?? '');
      setUsername(u.data.username ?? '');
      setBio(u.data.bio ?? '');
      setStats({
        postCount: u.data.post_count ?? 0,
        followerCount: u.data.follower_count ?? 0,
        followingCount: u.data.following_count ?? 0,
      });
      setLicenseType(u.data.license_type ?? '');
      setBikeType(u.data.bike_type ?? '');
    }
    setPosts(p?.data.posts ?? []);
    setBadges(b?.data.rewards ?? []);
    setGarage(g?.data.motorcycles ?? []);
    setRoutes(r?.data.routes ?? []);
    if (s) {
      setFollowing(s.data.following ?? false);
      setFollowedBy(s.data.followed_by ?? false);
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
          <RiderChips licenseType={licenseType} bikeType={bikeType} />

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statNum}>{stats.postCount}</Text>
              <Text style={styles.statLabel}>Gönderi</Text>
            </View>
            <Pressable
              style={styles.statItem}
              onPress={() => openFollows('followers')}
              disabled={!canViewFollows}
              hitSlop={8}
            >
              <Text style={styles.statNum}>{stats.followerCount}</Text>
              <Text style={styles.statLabel}>Takipçi</Text>
            </Pressable>
            <Pressable
              style={styles.statItem}
              onPress={() => openFollows('following')}
              disabled={!canViewFollows}
              hitSlop={8}
            >
              <Text style={styles.statNum}>{stats.followingCount}</Text>
              <Text style={styles.statLabel}>Takip</Text>
            </Pressable>
          </View>
          {badges.length > 0 && (
            <View style={styles.badges}>
              {badges.map((b) => {
                const tm = tierMeta(b.tier);
                return (
                  <View key={b.id} style={[styles.chip, { borderColor: tm.color }]}>
                    <MaterialCommunityIcons name="medal" size={14} color={tm.color} />
                    <Text style={styles.chipText}>{b.description || b.type}</Text>
                  </View>
                );
              })}
            </View>
          )}
        </LinearGradient>

        {!isSelf && (
          <>
            <FollowButton
              userId={userId}
              following={following}
              onChange={(next) => {
                setFollowing(next);
                setStats((s) => ({ ...s, followerCount: Math.max(0, s.followerCount + (next ? 1 : -1)) }));
              }}
            />
            <Button title="Meydan Oku" variant="ghost" icon="flag-checkered" onPress={() => setChallengeOpen(true)} />
          </>
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

        {garage.length > 0 && (
          <View>
            <View style={styles.sectionRow}>
              <MaterialCommunityIcons name="garage-variant" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>Garaj</Text>
            </View>
            <View style={styles.listCard}>
              {garage.map((m, i) => (
                <View key={m.id} style={[styles.listRow, i > 0 && styles.listDivider]}>
                  <MaterialCommunityIcons name="motorbike" size={20} color={colors.primary} />
                  <Text style={styles.listName} numberOfLines={1}>{m.name}</Text>
                  {m.year ? <Text style={styles.listMeta}>{m.year}</Text> : null}
                </View>
              ))}
            </View>
          </View>
        )}

        {routes.length > 0 && (
          <View>
            <View style={styles.sectionRow}>
              <MaterialCommunityIcons name="map-marker-path" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>Rotalar</Text>
            </View>
            <View style={styles.listCard}>
              {routes.map((r, i) => (
                <View key={r.id} style={[styles.listRow, i > 0 && styles.listDivider]}>
                  <MaterialCommunityIcons name="map-marker-path" size={20} color={colors.primary} />
                  <Text style={styles.listName} numberOfLines={1}>{r.name}</Text>
                  <Text style={styles.listMeta}>{r.distance.toFixed(1)} km</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
      <PostDetail post={viewer} onClose={() => setViewer(null)} />
      <AvatarViewer uri={zoomUri} onClose={() => setZoomUri(null)} />
      <CreateChallengeModal
        visible={challengeOpen}
        onClose={() => setChallengeOpen(false)}
        inviteUserId={userId}
        inviteName={name}
      />
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
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: 15, letterSpacing: 0.3 },
  listCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  listDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  listName: { color: colors.text, flex: 1, fontWeight: '700', fontSize: 14 },
  listMeta: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  gridItem: { borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  gridImg: { width: '100%', height: '100%' },
  multi: { position: 'absolute', top: 4, right: 4 },
});
