import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

import { EmptyState } from './ui';
import { api, errorMessage } from '../api/client';
import { colors, gradients, radius, spacing } from '../theme';

type Comment = {
  id: number;
  author: string;
  body: string;
  parent_id: number | null;
  like_count: number;
  liked: boolean;
  created_at: string;
};

type ReplyTarget = { id: number; author: string } | null;

// Cap visual nesting so deep threads stay readable on narrow screens.
const MAX_INDENT_DEPTH = 6;
const INDENT = 14;

// CommentsView is a self-contained threaded comments list + composer for a post.
// keyboardOffset is the height of any header above this view (e.g. a navigation
// header) so the composer lands exactly atop the keyboard.
export function CommentsView({
  postId,
  onAdded,
  keyboardOffset = 0,
}: {
  postId: number;
  onAdded?: () => void;
  keyboardOffset?: number;
}) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyTarget>(null);

  // Start a reply: remember the target and pop the keyboard so the user can
  // type immediately and see what they write above it.
  const startReply = useCallback((c: Comment) => {
    setReplyTo({ id: c.id, author: c.author });
    inputRef.current?.focus();
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get(`/api/posts/${postId}/comments`);
      setComments(data.comments ?? []);
    } catch {
      // ignore; empty state will render
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  // Group children by parent so we can render the tree recursively.
  const { roots, childrenOf } = useMemo(() => {
    const byParent = new Map<number, Comment[]>();
    const top: Comment[] = [];
    for (const c of comments) {
      if (c.parent_id == null) {
        top.push(c);
      } else {
        const arr = byParent.get(c.parent_id) ?? [];
        arr.push(c);
        byParent.set(c.parent_id, arr);
      }
    }
    return { roots: top, childrenOf: (id: number) => byParent.get(id) ?? [] };
  }, [comments]);

  async function send() {
    const text = body.trim();
    if (!text) return;
    try {
      setSending(true);
      const { data } = await api.post(`/api/posts/${postId}/comments`, {
        body: text,
        parent_id: replyTo?.id ?? null,
      });
      setComments((c) => [...c, data]);
      setBody('');
      setReplyTo(null);
      onAdded?.();
    } catch (err) {
      setBody(text);
      alert(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function toggleLike(c: Comment) {
    const next = !c.liked;
    // optimistic
    setComments((list) =>
      list.map((x) =>
        x.id === c.id ? { ...x, liked: next, like_count: x.like_count + (next ? 1 : -1) } : x,
      ),
    );
    try {
      if (next) await api.post(`/api/comments/${c.id}/like`);
      else await api.delete(`/api/comments/${c.id}/like`);
    } catch {
      // revert
      setComments((list) =>
        list.map((x) =>
          x.id === c.id ? { ...x, liked: c.liked, like_count: c.like_count } : x,
        ),
      );
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardOffset}
    >
      <FlatList
        data={roots}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!loading ? <EmptyState icon="comment-text-outline" title="Henüz yorum yok" hint="İlk yorumu sen yaz!" /> : null}
        renderItem={({ item }) => (
          <CommentNode
            comment={item}
            depth={0}
            childrenOf={childrenOf}
            onReply={startReply}
            onToggleLike={toggleLike}
          />
        )}
      />

      {replyTo && (
        <View style={styles.replyBar}>
          <Text style={styles.replyText} numberOfLines={1}>
            <Text style={styles.replyAt}>@{replyTo.author}</Text> kullanıcısına yanıt veriliyor
          </Text>
          <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
            <MaterialCommunityIcons name="close" size={18} color={colors.textMuted} />
          </Pressable>
        </View>
      )}

      <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={body}
          onChangeText={setBody}
          placeholder={replyTo ? 'Yanıt yaz...' : 'Yorum ekle...'}
          placeholderTextColor={colors.textMuted}
          multiline
        />
        <Pressable style={styles.send} onPress={send} disabled={sending || !body.trim()}>
          <MaterialCommunityIcons name="send" size={22} color={body.trim() ? colors.primary : colors.textMuted} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// CommentNode renders a single comment and, recursively, its replies.
function CommentNode({
  comment,
  depth,
  childrenOf,
  onReply,
  onToggleLike,
}: {
  comment: Comment;
  depth: number;
  childrenOf: (id: number) => Comment[];
  onReply: (c: Comment) => void;
  onToggleLike: (c: Comment) => void;
}) {
  const replies = childrenOf(comment.id);
  // Indentation accumulates through nested Views; stop adding past the cap so
  // deep threads don't squeeze off-screen.
  const marginLeft = depth > 0 && depth <= MAX_INDENT_DEPTH ? INDENT : 0;

  return (
    <View style={{ marginLeft }}>
      <View style={[styles.row, depth > 0 && styles.replyRow]}>
        <LinearGradient colors={gradients.primary} style={styles.avatar}>
          <Text style={styles.avatarText}>{comment.author?.charAt(0).toUpperCase() ?? 'M'}</Text>
        </LinearGradient>
        <View style={styles.bubbleWrap}>
          <View style={styles.bubble}>
            <Text style={styles.author}>{comment.author}</Text>
            <Text style={styles.body}>{comment.body}</Text>
          </View>
          <View style={styles.actions}>
            <Pressable style={styles.action} onPress={() => onToggleLike(comment)} hitSlop={6}>
              <MaterialCommunityIcons
                name={comment.liked ? 'heart' : 'heart-outline'}
                size={15}
                color={comment.liked ? colors.danger : colors.textMuted}
              />
              {comment.like_count > 0 && <Text style={styles.actionText}>{comment.like_count}</Text>}
            </Pressable>
            <Pressable style={styles.action} onPress={() => onReply(comment)} hitSlop={6}>
              <MaterialCommunityIcons name="reply" size={15} color={colors.textMuted} />
              <Text style={styles.actionText}>Yanıtla</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {replies.map((r) => (
        <CommentNode
          key={r.id}
          comment={r}
          depth={depth + 1}
          childrenOf={childrenOf}
          onReply={onReply}
          onToggleLike={onToggleLike}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },
  row: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  replyRow: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.sm },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900' },
  bubbleWrap: { flex: 1, gap: 2 },
  bubble: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.border },
  author: { color: colors.text, fontWeight: '800', fontSize: 13, marginBottom: 2 },
  body: { color: colors.text },
  actions: { flexDirection: 'row', gap: spacing.md, paddingLeft: spacing.xs },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  replyText: { color: colors.textMuted, fontSize: 13, flex: 1 },
  replyAt: { color: colors.primary, fontWeight: '700' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    color: colors.text,
    backgroundColor: colors.bgAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
  },
  send: { padding: spacing.sm },
});
