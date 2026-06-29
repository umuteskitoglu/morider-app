import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { FeedStackParams } from '../navigation/RootNavigator';
import { LikersSheet } from '../components/LikersSheet';
import { EmptyState } from '../components/ui';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, gradients, spacing } from '../theme';

type Post = {
  id: number;
  user_id: number;
  author: string;
  caption: string;
  location_name: string;
  created_at: string;
  photos: string[];
  like_count: number;
  comment_count: number;
  liked: boolean;
};
type Props = NativeStackScreenProps<FeedStackParams, 'FeedList'>;

// Feed cache. The list is kept across navigation (memory) and across app
// restarts (disk) so returning to the tab shows posts instantly — Instagram
// style — instead of blanking out and refetching on every focus. The network
// is only hit when the cache is stale or the user pulls to refresh.
const FEED_CACHE_KEY = 'morider.feedCache';
const FRESH_MS = 30_000;
let feedMemCache: Post[] | null = null;
let feedFetchedAt = 0;

// Marks the cache stale so the next focus refetches — e.g. after creating a
// post, which must appear at the top of the feed.
export function invalidateFeedCache() {
  feedFetchedAt = 0;
}

// Lets other screens (e.g. deleting a post) drop an item from the cache so it
// never flashes back from a stale list before the next network refresh.
export function removeFromFeedCache(postId: number) {
  if (feedMemCache) {
    feedMemCache = feedMemCache.filter((p) => p.id !== postId);
    AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(feedMemCache)).catch(() => {});
  }
}

export default function FeedScreen({ navigation }: Props) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [posts, setPosts] = useState<Post[]>(() => feedMemCache ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(feedMemCache === null);
  const [refreshing, setRefreshing] = useState(false);
  const [height, setHeight] = useState(0);
  const [likersPostId, setLikersPostId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/feed');
      const next: Post[] = data.posts ?? [];
      feedMemCache = next;
      feedFetchedAt = Date.now();
      setPosts(next);
      setError(null);
      AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(next)).catch(() => {});
    } catch (err) {
      // Keep showing cached posts on failure; only surface the error when there
      // is nothing to show.
      if (!feedMemCache || feedMemCache.length === 0) setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Cold-start hydration: paint the last feed from disk before the first fetch.
  useEffect(() => {
    if (feedMemCache !== null) return;
    AsyncStorage.getItem(FEED_CACHE_KEY)
      .then((raw) => {
        if (raw && feedMemCache === null) {
          const cached = JSON.parse(raw) as Post[];
          feedMemCache = cached;
          setPosts(cached);
        }
      })
      .catch(() => {});
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Show cache instantly; only refresh in the background when it is stale.
      if (Date.now() - feedFetchedAt > FRESH_MS) {
        load();
      }
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  function onLayout(e: LayoutChangeEvent) {
    setHeight(e.nativeEvent.layout.height);
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      {height > 0 && (
        <FlatList
          data={posts}
          keyExtractor={(item) => String(item.id)}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={[styles.empty, { height }]}>
              {loading ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <EmptyState
                  icon="image-multiple-outline"
                  title={error ?? 'Henüz paylaşım yok'}
                  hint={error ? undefined : 'İlk fotoğrafını sen paylaş — yoldaki anlarını topluluğa göster!'}
                />
              )}
            </View>
          }
          renderItem={({ item }) => (
            <PostItem
              post={item}
              width={width}
              height={height}
              onOpenProfile={(userId, name) => navigation.navigate('UserProfile', { userId, name })}
              onOpenComments={(postId) => navigation.navigate('Comments', { postId })}
              onOpenLikers={(postId) => setLikersPostId(postId)}
            />
          )}
        />
      )}

      <Pressable
        style={[styles.searchBtn, { top: insets.top + spacing.sm }]}
        onPress={() => navigation.navigate('UserSearch')}
        hitSlop={8}
      >
        <MaterialCommunityIcons name="account-search" size={22} color="#fff" />
      </Pressable>

      <Pressable style={styles.fab} onPress={() => navigation.navigate('CreatePost')}>
        <MaterialCommunityIcons name="plus" size={28} color="#fff" />
      </Pressable>

      <LikersSheet postId={likersPostId} onClose={() => setLikersPostId(null)} />
    </View>
  );
}

function PostItem({
  post,
  width,
  height,
  onOpenProfile,
  onOpenComments,
  onOpenLikers,
}: {
  post: Post;
  width: number;
  height: number;
  onOpenProfile: (userId: number, name: string) => void;
  onOpenComments: (postId: number) => void;
  onOpenLikers: (postId: number) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [liked, setLiked] = useState(post.liked);
  const [likeCount, setLikeCount] = useState(post.like_count);
  const lastTap = useRef(0);
  const heart = useRef(new Animated.Value(0)).current;

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    setIdx(Math.round(e.nativeEvent.contentOffset.x / width));
  }

  async function toggleLike() {
    const next = !liked;
    setLiked(next); // optimistic
    setLikeCount((n) => n + (next ? 1 : -1));
    try {
      if (next) await api.post(`/api/posts/${post.id}/like`);
      else await api.delete(`/api/posts/${post.id}/like`);
    } catch {
      setLiked(!next); // revert
      setLikeCount((n) => n + (next ? -1 : 1));
    }
  }

  // Pop a heart burst in the centre of the photo.
  function playHeart() {
    heart.setValue(0);
    Animated.sequence([
      Animated.spring(heart, { toValue: 1, friction: 4, useNativeDriver: true }),
      Animated.timing(heart, { toValue: 0, duration: 350, delay: 300, useNativeDriver: true }),
    ]).start();
  }

  // Double-tap always likes (never unlikes), Instagram-style.
  async function likeViaDoubleTap() {
    playHeart();
    if (liked) return;
    setLiked(true);
    setLikeCount((n) => n + 1);
    try {
      await api.post(`/api/posts/${post.id}/like`);
    } catch {
      setLiked(false);
      setLikeCount((n) => n - 1);
    }
  }

  function onPhotoTap() {
    const now = Date.now();
    if (now - lastTap.current < 280) {
      lastTap.current = 0;
      likeViaDoubleTap();
    } else {
      lastTap.current = now;
    }
  }

  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      <FlatList
        data={post.photos}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        renderItem={({ item }) => (
          <Pressable onPress={onPhotoTap}>
            <Image
              source={apiBaseURL() + item}
              style={{ width, height }}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={150}
            />
          </Pressable>
        )}
      />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.heartBurst,
          { opacity: heart, transform: [{ scale: heart.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }] },
        ]}
      >
        <MaterialCommunityIcons name="heart" size={120} color="rgba(255,255,255,0.92)" />
      </Animated.View>

      {post.photos.length > 1 && (
        <View style={styles.counter}>
          <Text style={styles.counterText}>
            {idx + 1}/{post.photos.length}
          </Text>
        </View>
      )}

      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.92)']} style={styles.overlay}>
        <Pressable style={styles.authorRow} onPress={() => onOpenProfile(post.user_id, post.author)}>
          <LinearGradient colors={gradients.primary} style={styles.avatar}>
            <Text style={styles.avatarText}>{post.author?.charAt(0).toUpperCase() ?? 'M'}</Text>
          </LinearGradient>
          <Text style={styles.author}>{post.author}</Text>
        </Pressable>
        {post.caption ? <Text style={styles.caption}>{post.caption}</Text> : null}
        {post.location_name ? (
          <View style={styles.locationRow}>
            <MaterialCommunityIcons name="map-marker" size={14} color={colors.accent} />
            <Text style={styles.location}>{post.location_name}</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <View style={styles.action}>
            <Pressable onPress={toggleLike} hitSlop={8}>
              <MaterialCommunityIcons
                name={liked ? 'heart' : 'heart-outline'}
                size={26}
                color={liked ? colors.danger : '#fff'}
              />
            </Pressable>
            <Pressable onPress={() => onOpenLikers(post.id)} hitSlop={8}>
              <Text style={styles.actionText}>{likeCount}</Text>
            </Pressable>
          </View>
          <Pressable style={styles.action} onPress={() => onOpenComments(post.id)} hitSlop={8}>
            <MaterialCommunityIcons name="comment-outline" size={24} color="#fff" />
            <Text style={styles.actionText}>{post.comment_count}</Text>
          </Pressable>
        </View>

        {post.photos.length > 1 && (
          <View style={styles.dots}>
            {post.photos.map((_, i) => (
              <View key={i} style={[styles.dot, i === idx && styles.dotActive]} />
            ))}
          </View>
        )}
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  empty: { alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  emptyText: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  fab: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  searchBtn: {
    position: 'absolute',
    left: spacing.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    position: 'absolute',
    top: spacing.lg,
    right: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
  },
  counterText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  heartBurst: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    paddingBottom: spacing.xl + spacing.md,
    gap: spacing.xs,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '900' },
  author: { color: '#fff', fontWeight: '800', fontSize: 15 },
  caption: { color: '#fff', fontSize: 15, lineHeight: 20 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  location: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  actions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  dots: { flexDirection: 'row', gap: 5, marginTop: spacing.sm },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotActive: { backgroundColor: '#fff', width: 18 },
});
