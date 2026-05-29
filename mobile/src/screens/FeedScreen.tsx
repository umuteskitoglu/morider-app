import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Image,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { FeedStackParams } from '../navigation/RootNavigator';
import { LikersSheet } from '../components/LikersSheet';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

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

export default function FeedScreen({ navigation }: Props) {
  const { width } = useWindowDimensions();
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(0);
  const [likersPostId, setLikersPostId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { data } = await api.get('/api/feed');
      setPosts(data.posts ?? []);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

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
          ListEmptyComponent={
            <View style={[styles.empty, { height }]}>
              <MaterialCommunityIcons name="image-multiple-outline" size={48} color={colors.border} />
              <Text style={styles.emptyText}>{error ?? 'Henüz paylaşım yok.\nİlk fotoğrafı sen paylaş!'}</Text>
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
          <Image source={{ uri: apiBaseURL() + item }} style={{ width, height }} resizeMode="contain" />
        )}
      />

      {post.photos.length > 1 && (
        <View style={styles.counter}>
          <Text style={styles.counterText}>
            {idx + 1}/{post.photos.length}
          </Text>
        </View>
      )}

      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.92)']} style={styles.overlay}>
        <Pressable style={styles.authorRow} onPress={() => onOpenProfile(post.user_id, post.author)}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{post.author?.charAt(0).toUpperCase() ?? 'M'}</Text>
          </View>
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
