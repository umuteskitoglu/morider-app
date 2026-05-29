import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { api, apiBaseURL } from '../api/client';
import { CommentsView } from './CommentsView';
import { LikersSheet } from './LikersSheet';
import { colors, spacing } from '../theme';

export type DetailPost = {
  id: number;
  user_id: number;
  author: string;
  caption: string;
  location_name: string;
  photos: string[];
  like_count: number;
  comment_count: number;
  liked: boolean;
};

// PostDetail is a full-screen, swipe-to-dismiss post viewer with like/comment
// actions, a likers list and inline comments. Used from the profile grids.
export function PostDetail({ post, onClose }: { post: DetailPost | null; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const [idx, setIdx] = useState(0);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [showComments, setShowComments] = useState(false);
  const [showLikers, setShowLikers] = useState(false);

  const translateY = useRef(new Animated.Value(0)).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (post) {
      setIdx(0);
      setLiked(post.liked);
      setLikeCount(post.like_count);
      setCommentCount(post.comment_count);
      translateY.setValue(0);
    }
  }, [post, translateY]);

  // Vertical drag dismisses; horizontal swipes fall through to the photo carousel.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > Math.abs(g.dx) && Math.abs(g.dy) > 14,
      onPanResponderMove: (_, g) => translateY.setValue(g.dy),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dy) > 120) {
          onCloseRef.current();
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  async function toggleLike() {
    if (!post) return;
    const next = !liked;
    setLiked(next);
    setLikeCount((n) => n + (next ? 1 : -1));
    try {
      if (next) await api.post(`/api/posts/${post.id}/like`);
      else await api.delete(`/api/posts/${post.id}/like`);
    } catch {
      setLiked(!next);
      setLikeCount((n) => n + (next ? -1 : 1));
    }
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    setIdx(Math.round(e.nativeEvent.contentOffset.x / width));
  }

  return (
    <Modal visible={!!post} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.bg}>
        {post && (
          <Animated.View style={[styles.flex, { transform: [{ translateY }] }]} {...pan.panHandlers}>
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

            <Pressable style={styles.close} onPress={onClose} hitSlop={12}>
              <MaterialCommunityIcons name="chevron-down" size={28} color="#fff" />
            </Pressable>

            {/* Right action rail — icons carry a soft shadow so they stay visible
                on light photos (Instagram-style). */}
            <View style={styles.rail}>
              <Pressable style={styles.railBtn} onPress={toggleLike} hitSlop={8}>
                <MaterialCommunityIcons
                  name={liked ? 'heart' : 'heart-outline'}
                  size={34}
                  color={liked ? colors.danger : '#fff'}
                  style={styles.iconShadow}
                />
              </Pressable>
              <Pressable onPress={() => setShowLikers(true)} hitSlop={8}>
                <Text style={styles.railText}>{likeCount}</Text>
              </Pressable>
              <Pressable style={styles.railBtn} onPress={() => setShowComments(true)} hitSlop={8}>
                <MaterialCommunityIcons name="comment-outline" size={32} color="#fff" style={styles.iconShadow} />
              </Pressable>
              <Text style={styles.railText}>{commentCount}</Text>
            </View>

            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.92)']} style={styles.overlay}>
              <Text style={styles.author}>{post.author}</Text>
              {post.caption ? <Text style={styles.caption}>{post.caption}</Text> : null}
              {post.location_name ? (
                <View style={styles.locationRow}>
                  <MaterialCommunityIcons name="map-marker" size={14} color={colors.accent} />
                  <Text style={styles.location}>{post.location_name}</Text>
                </View>
              ) : null}
              {likeCount > 0 && (
                <Pressable onPress={() => setShowLikers(true)} hitSlop={8}>
                  <Text style={styles.likesLink}>{likeCount} beğeni · beğenenleri gör</Text>
                </Pressable>
              )}
            </LinearGradient>
          </Animated.View>
        )}
      </View>

      {/* Comments sheet */}
      <Modal visible={showComments} animationType="slide" onRequestClose={() => setShowComments(false)}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Yorumlar</Text>
          <Pressable onPress={() => setShowComments(false)} hitSlop={12}>
            <MaterialCommunityIcons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        {post && <CommentsView postId={post.id} onAdded={() => setCommentCount((n) => n + 1)} />}
      </Modal>

      {/* Likers sheet */}
      <LikersSheet postId={showLikers && post ? post.id : null} onClose={() => setShowLikers(false)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: '#000' },
  flex: { flex: 1 },
  counter: {
    position: 'absolute',
    top: 54,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
  },
  counterText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  close: {
    position: 'absolute',
    top: 50,
    left: spacing.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rail: { position: 'absolute', right: spacing.md, bottom: 150, alignItems: 'center', gap: spacing.sm },
  railBtn: { alignItems: 'center' },
  railText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  iconShadow: { textShadowColor: 'rgba(0,0,0,0.7)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    paddingBottom: spacing.xl + spacing.md,
    paddingRight: 80,
    gap: spacing.xs,
  },
  author: { color: '#fff', fontWeight: '800', fontSize: 16 },
  caption: { color: '#fff', fontSize: 15, lineHeight: 20 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  location: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  likesLink: { color: '#fff', fontWeight: '700', marginTop: spacing.xs, opacity: 0.9 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { color: colors.text, fontWeight: '800', fontSize: 16 },
});
