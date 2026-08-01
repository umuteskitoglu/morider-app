import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, EmptyState } from '../components/ui';
import { ChatStackParams } from '../navigation/RootNavigator';
import {
  Community,
  CommunityPost,
  deletePost,
  fetchCommunity,
  fetchPosts,
  joinCommunity,
  leaveCommunity,
  setPostLike,
  votePoll,
} from '../lib/communities';
import { useAuth } from '../store/auth';
import { MEDIA_FULL, errorMessage, mediaURL } from '../api/client';
import { formatDateTime } from '../lib/datetime';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<ChatStackParams, 'CommunityDetail'>;

const PHOTO_SIZE = Dimensions.get('window').width - spacing.md * 4;

// CommunityDetailScreen — the club board: a header card with membership
// controls and the admin-only broadcast feed beneath it.
export default function CommunityDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { user } = useAuth();
  const [community, setCommunity] = useState<Community | null>(null);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [locked, setLocked] = useState(false); // closed community, not a member
  const [refreshing, setRefreshing] = useState(false);
  const [joining, setJoining] = useState(false);

  const isAdmin = community?.my_role === 'owner' || community?.my_role === 'admin';
  const isActiveMember = community?.my_status === 'active';

  useLayoutEffect(() => {
    if (community) navigation.setOptions({ title: community.name });
  }, [navigation, community]);

  const load = useCallback(async () => {
    try {
      const c = await fetchCommunity(id);
      setCommunity(c);
      try {
        setPosts(await fetchPosts(id));
        setLocked(false);
      } catch {
        // 403 on a closed community the rider hasn't joined yet.
        setPosts([]);
        setLocked(c.privacy === 'closed' && c.my_status !== 'active');
      }
    } catch {
      // header keeps the last known state; pull-to-refresh retries
    }
  }, [id]);

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

  async function join() {
    try {
      setJoining(true);
      await joinCommunity(id);
      await load();
    } catch (err) {
      Alert.alert('Katılınamadı', errorMessage(err));
    } finally {
      setJoining(false);
    }
  }

  function leave() {
    const pending = community?.my_status === 'pending';
    Alert.alert(
      pending ? 'İstek geri çekilsin mi?' : 'Topluluktan ayrıl',
      pending ? 'Katılım isteğin iptal edilecek.' : `${community?.name} topluluğundan ayrılmak istiyor musun?`,
      [
        { text: 'Vazgeç', style: 'cancel' },
        {
          text: pending ? 'Geri Çek' : 'Ayrıl',
          style: 'destructive',
          onPress: async () => {
            try {
              await leaveCommunity(id);
              await load();
            } catch (err) {
              Alert.alert('Olmadı', errorMessage(err));
            }
          },
        },
      ],
    );
  }

  function confirmDeletePost(post: CommunityPost) {
    Alert.alert('Yayın silinsin mi?', 'Bu işlem geri alınamaz.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePost(post.id);
            setPosts((list) => list.filter((p) => p.id !== post.id));
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          }
        },
      },
    ]);
  }

  async function toggleLike(post: CommunityPost) {
    const next = !post.liked;
    setPosts((list) =>
      list.map((p) =>
        p.id === post.id ? { ...p, liked: next, like_count: p.like_count + (next ? 1 : -1) } : p,
      ),
    );
    try {
      await setPostLike(post.id, next);
    } catch {
      setPosts((list) =>
        list.map((p) => (p.id === post.id ? { ...p, liked: post.liked, like_count: post.like_count } : p)),
      );
    }
  }

  async function vote(post: CommunityPost, optionId: number) {
    try {
      const poll = await votePoll(post.id, optionId);
      setPosts((list) => list.map((p) => (p.id === post.id ? { ...p, poll } : p)));
    } catch (err) {
      Alert.alert('Oy verilemedi', errorMessage(err));
    }
  }

  const header = community ? (
    <View style={styles.headerCard}>
      <View style={styles.headerTop}>
        <LinearGradient colors={gradients.primary} style={styles.headerAvatar}>
          <Text style={styles.headerAvatarText}>{community.name.charAt(0).toUpperCase()}</Text>
        </LinearGradient>
        <View style={styles.flex}>
          <Text style={styles.headerName}>{community.name}</Text>
          <View style={styles.metaRow}>
            <MaterialCommunityIcons
              name={community.privacy === 'closed' ? 'lock' : 'earth'}
              size={13}
              color={colors.textMuted}
            />
            <Text style={styles.metaText}>
              {community.privacy === 'closed' ? 'Kapalı topluluk' : 'Herkese açık'} · {community.member_count} üye
            </Text>
          </View>
        </View>
      </View>
      {community.description ? <Text style={styles.desc}>{community.description}</Text> : null}

      <View style={styles.actionRow}>
        {community.my_status === '' && (
          <Button
            title={community.privacy === 'closed' ? 'Katılım İsteği Gönder' : 'Katıl'}
            icon="account-plus"
            size="sm"
            onPress={join}
            loading={joining}
          />
        )}
        {community.my_status === 'pending' && (
          <Button title="İstek Gönderildi" icon="clock-outline" size="sm" variant="glass" onPress={leave} />
        )}
        {isActiveMember && (
          <Button
            title="Üyeler"
            icon="account-group"
            size="sm"
            variant="glass"
            onPress={() => navigation.navigate('CommunityMembers', { id, myRole: community.my_role })}
          />
        )}
        {isActiveMember && community.my_role !== 'owner' && (
          <Button title="Ayrıl" icon="exit-to-app" size="sm" variant="ghost" onPress={leave} />
        )}
      </View>

      {isAdmin && (community.pending_count ?? 0) > 0 && (
        <Pressable
          style={styles.pendingBar}
          onPress={() => navigation.navigate('CommunityMembers', { id, myRole: community.my_role })}
        >
          <MaterialCommunityIcons name="account-clock" size={16} color={colors.accent} />
          <Text style={styles.pendingText}>{community.pending_count} katılım isteği onay bekliyor</Text>
          <MaterialCommunityIcons name="chevron-right" size={18} color={colors.accent} />
        </Pressable>
      )}
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      <FlatList
        data={posts}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListEmptyComponent={
          locked ? (
            <EmptyState
              icon="lock-outline"
              title="Bu topluluk kapalı"
              hint="Yayınları görmek için katılım isteği gönder; bir admin onaylayınca içerik açılır."
            />
          ) : (
            <EmptyState
              icon="bullhorn-outline"
              title="Henüz yayın yok"
              hint={isAdmin ? 'İlk duyuruyu + butonuyla sen paylaş.' : 'Adminler bir şey paylaştığında burada görünecek.'}
            />
          )
        }
        renderItem={({ item }) => (
          <PostCard
            post={item}
            canDelete={item.user_id === user?.id || community?.my_role === 'owner'}
            canInteract={isActiveMember}
            onLike={() => toggleLike(item)}
            onComments={() => navigation.navigate('CommunityComments', { postId: item.id })}
            onVote={(optionId) => vote(item, optionId)}
            onDelete={() => confirmDeletePost(item)}
          />
        )}
      />

      {isAdmin && (
        <Pressable
          style={styles.fab}
          onPress={() => navigation.navigate('CommunityPostCreate', { id })}
          accessibilityRole="button"
          accessibilityLabel="Yeni yayın paylaş"
        >
          <LinearGradient colors={gradients.primary} style={styles.fabInner}>
            <MaterialCommunityIcons name="bullhorn" size={24} color="#fff" />
          </LinearGradient>
        </Pressable>
      )}
    </View>
  );
}

// PostCard renders one broadcast: author, body, photos, then the optional
// route/event/poll attachment and the like/comment row.
function PostCard({
  post,
  canDelete,
  canInteract,
  onLike,
  onComments,
  onVote,
  onDelete,
}: {
  post: CommunityPost;
  canDelete: boolean;
  canInteract: boolean;
  onLike: () => void;
  onComments: () => void;
  onVote: (optionId: number) => void;
  onDelete: () => void;
}) {
  // Route/event attachments open screens in other tab stacks (Profile/Events),
  // so this hop is intentionally untyped.
  const rootNavigation = useNavigation<any>();

  return (
    <View style={styles.post}>
      <View style={styles.postHead}>
        <LinearGradient colors={gradients.primary} style={styles.postAvatar}>
          <Text style={styles.postAvatarText}>{post.author?.charAt(0).toUpperCase() ?? 'M'}</Text>
        </LinearGradient>
        <View style={styles.flex}>
          <Text style={styles.postAuthor}>{post.author}</Text>
          <Text style={styles.postDate}>{formatDateTime(post.created_at)}</Text>
        </View>
        {post.pinned && <MaterialCommunityIcons name="pin" size={16} color={colors.accent} />}
        {canDelete && (
          <Pressable onPress={onDelete} hitSlop={12} accessibilityRole="button" accessibilityLabel="Yayını sil">
            <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.textMuted} />
          </Pressable>
        )}
      </View>

      {post.body ? <Text style={styles.postBody}>{post.body}</Text> : null}

      {post.photos.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
          {post.photos.map((url) => (
            <Image key={url} source={{ uri: mediaURL(url, MEDIA_FULL) }} style={styles.photo} contentFit="cover" />
          ))}
        </ScrollView>
      )}

      {post.route && (
        <Pressable
          style={styles.attachment}
          onPress={() =>
            rootNavigation.navigate('Profile', {
              screen: 'RouteDetail',
              params: { id: post.route!.id, name: post.route!.name },
            })
          }
        >
          <MaterialCommunityIcons name="map-marker-path" size={20} color={colors.cyan} />
          <View style={styles.flex}>
            <Text style={styles.attachmentTitle}>{post.route.name}</Text>
            <Text style={styles.attachmentMeta}>{(post.route.distance / 1000).toFixed(1)} km rota</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color={colors.textMuted} />
        </Pressable>
      )}

      {post.event && (
        <Pressable
          style={styles.attachment}
          onPress={() =>
            rootNavigation.navigate('Events', {
              screen: 'EventDetail',
              params: { code: post.event!.code },
            })
          }
        >
          <MaterialCommunityIcons name="calendar-clock" size={20} color={colors.accent} />
          <View style={styles.flex}>
            <Text style={styles.attachmentTitle}>{post.event.title}</Text>
            <Text style={styles.attachmentMeta}>{formatDateTime(post.event.start_at)}</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color={colors.textMuted} />
        </Pressable>
      )}

      {post.poll && (
        <View style={styles.poll}>
          <Text style={styles.pollQuestion}>{post.poll.question}</Text>
          {post.poll.options.map((opt) => {
            const pct = post.poll!.total_votes > 0 ? Math.round((opt.votes / post.poll!.total_votes) * 100) : 0;
            const mine = post.poll!.my_vote === opt.id;
            return (
              <Pressable
                key={opt.id}
                style={[styles.pollOption, mine && styles.pollOptionMine]}
                onPress={() => canInteract && onVote(opt.id)}
              >
                <View style={[styles.pollFill, { width: `${pct}%` }]} />
                <View style={styles.pollOptionRow}>
                  <Text style={[styles.pollLabel, mine && styles.pollLabelMine]} numberOfLines={1}>
                    {mine ? '● ' : ''}
                    {opt.label}
                  </Text>
                  <Text style={styles.pollPct}>%{pct}</Text>
                </View>
              </Pressable>
            );
          })}
          <Text style={styles.pollTotal}>{post.poll.total_votes} oy</Text>
        </View>
      )}

      <View style={styles.postActions}>
        <Pressable
          style={styles.postAction}
          onPress={onLike}
          disabled={!canInteract}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Beğen"
          accessibilityState={{ disabled: !canInteract }}
        >
          <MaterialCommunityIcons
            name={post.liked ? 'heart' : 'heart-outline'}
            size={20}
            color={post.liked ? colors.danger : colors.textMuted}
          />
          {post.like_count > 0 && <Text style={styles.postActionText}>{post.like_count}</Text>}
        </Pressable>
        <Pressable
          style={styles.postAction}
          onPress={onComments}
          disabled={!canInteract}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Yorumları aç"
          accessibilityState={{ disabled: !canInteract }}
        >
          <MaterialCommunityIcons name="comment-outline" size={19} color={colors.textMuted} />
          <Text style={styles.postActionText}>
            {post.comment_count > 0 ? post.comment_count : 'Yorum yap'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, paddingBottom: 120, flexGrow: 1 },
  flex: { flex: 1 },

  headerCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerAvatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  headerAvatarText: { color: '#fff', fontWeight: '900', fontSize: 22 },
  headerName: { color: colors.text, fontWeight: '900', fontSize: 18 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText: { color: colors.textMuted, fontSize: 13 },
  desc: { color: colors.textMuted, lineHeight: 20 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pendingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,176,32,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.25)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pendingText: { color: colors.accent, fontWeight: '700', fontSize: 13, flex: 1 },

  post: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  postHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  postAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  postAvatarText: { color: '#fff', fontWeight: '900' },
  postAuthor: { color: colors.text, fontWeight: '800', fontSize: 14 },
  postDate: { color: colors.textFaint, fontSize: 12 },
  postBody: { color: colors.text, lineHeight: 21, fontSize: 15 },
  photoStrip: { marginHorizontal: -spacing.xs },
  photo: {
    width: PHOTO_SIZE,
    height: PHOTO_SIZE * 0.66,
    borderRadius: radius.md,
    marginHorizontal: spacing.xs,
    backgroundColor: colors.bgAlt,
  },

  attachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm + 2,
  },
  attachmentTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
  attachmentMeta: { color: colors.textMuted, fontSize: 12, marginTop: 1 },

  poll: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm + 2,
    gap: spacing.sm,
  },
  pollQuestion: { color: colors.text, fontWeight: '800', fontSize: 14 },
  pollOption: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  pollOptionMine: { borderColor: colors.primary },
  pollFill: {
    ...StyleSheet.absoluteFillObject,
    width: '0%',
    backgroundColor: 'rgba(255,106,26,0.16)',
  },
  pollOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
  },
  pollLabel: { color: colors.text, fontSize: 14, flexShrink: 1 },
  pollLabelMine: { color: colors.primary, fontWeight: '800' },
  pollPct: { color: colors.textMuted, fontWeight: '800', fontSize: 13 },
  pollTotal: { color: colors.textFaint, fontSize: 12 },

  postActions: {
    flexDirection: 'row',
    gap: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  postAction: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  postActionText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },

  fab: { position: 'absolute', right: spacing.lg, bottom: spacing.xl },
  fabInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.glow,
  },
});
