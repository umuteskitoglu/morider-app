import React, { useCallback, useEffect, useState } from 'react';
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

import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Comment = { id: number; author: string; body: string; created_at: string };

// CommentsView is a self-contained comments list + composer for a post.
export function CommentsView({ postId, onAdded }: { postId: number; onAdded?: () => void }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);

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

  async function send() {
    const text = body.trim();
    if (!text) return;
    try {
      setSending(true);
      const { data } = await api.post(`/api/posts/${postId}/comments`, { body: text });
      setComments((c) => [...c, data]);
      setBody('');
      onAdded?.();
    } catch (err) {
      setBody(text);
      alert(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        data={comments}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>İlk yorumu sen yaz!</Text> : null}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{item.author?.charAt(0).toUpperCase() ?? 'M'}</Text>
            </View>
            <View style={styles.bubble}>
              <Text style={styles.author}>{item.author}</Text>
              <Text style={styles.body}>{item.body}</Text>
            </View>
          </View>
        )}
      />

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={body}
          onChangeText={setBody}
          placeholder="Yorum ekle..."
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },
  row: { flexDirection: 'row', gap: spacing.sm },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900' },
  bubble: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.border },
  author: { color: colors.text, fontWeight: '800', fontSize: 13, marginBottom: 2 },
  body: { color: colors.text },
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
