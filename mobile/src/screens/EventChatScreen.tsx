import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
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
import { useHeaderHeight } from '@react-navigation/elements';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EventsStackParams } from '../navigation/RootNavigator';
import { EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { useChatSocket } from '../lib/useChatSocket';
import { formatTime } from '../lib/datetime';
import { colors, radius, shadow, spacing } from '../theme';

type ChatMsg = { id: number; user_id: number; name: string; body: string; created_at: string };
type Props = NativeStackScreenProps<EventsStackParams, 'EventChat'>;

export default function EventChatScreen({ navigation, route }: Props) {
  const { code, title } = route.params;
  const { user } = useAuth();
  const headerHeight = useHeaderHeight();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');

  useLayoutEffect(() => {
    navigation.setOptions({ title: title ? `Sohbet · ${title}` : 'Sohbet' });
  }, [navigation, title]);

  const loadMessages = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/events/${code}/messages`);
      setMessages(data.messages ?? []);
    } catch {
      // best effort
    }
  }, [code]);

  const { connected, send: sendFrame } = useChatSocket({
    path: `/api/events/${code}/ws`,
    onMessage: (m: ChatMsg) => {
      if (m?.id == null) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    },
    onReconnect: loadMessages,
  });

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    if (sendFrame({ body })) setDraft('');
  }

  // Inverted list wants newest first; it then renders newest at the bottom near
  // the composer and scrolls up for history.
  const data = messages.slice().reverse();

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <FlatList
        data={data}
        inverted={data.length > 0}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={data.length === 0 ? styles.emptyWrap : styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <EmptyState icon="chat-outline" title="Henüz mesaj yok" hint="İlk mesajı sen yaz ve grubu hareketlendir!" />
          </View>
        }
        renderItem={({ item: m }) => {
          const mine = m.user_id === user?.id;
          return (
            <View style={[styles.msgRow, mine && styles.msgRowMine]}>
              <View style={[styles.msgBubble, mine ? styles.msgBubbleMine : styles.msgBubbleOther]}>
                {!mine ? (
                  <Pressable
                    onPress={() =>
                      (navigation.getParent() as any)?.navigate('Profile', {
                        screen: 'UserProfile',
                        params: { userId: m.user_id, name: m.name },
                      })
                    }
                  >
                    <Text style={styles.msgAuthor}>{m.name}</Text>
                  </Pressable>
                ) : null}
                <Text style={styles.msgBody}>{m.body}</Text>
                <Text style={styles.msgTime}>{formatTime(m.created_at)}</Text>
              </View>
            </View>
          );
        }}
      />

      {!connected && (
        <View style={styles.connBar}>
          <Text style={styles.connText}>Bağlanıyor…</Text>
        </View>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Mesaj yaz…"
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={2000}
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
        />
        <Pressable style={styles.sendBtn} onPress={send} disabled={!draft.trim()}>
          <MaterialCommunityIcons name="send" size={20} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.xs },
  emptyWrap: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  emptyText: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.md },
  msgBubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 2 },
  msgBubbleOther: { backgroundColor: colors.surfaceAlt, borderBottomLeftRadius: 2 },
  msgAuthor: { color: colors.accent, fontSize: 11, fontWeight: '800', marginBottom: 1 },
  // paddingRight gives the last glyph room: Android clips text to its measured
  // width and can otherwise cut the final character.
  msgBody: { color: '#fff', fontSize: 15, paddingRight: 3 },
  msgTime: { color: 'rgba(255,255,255,0.6)', fontSize: 10, alignSelf: 'flex-end', marginTop: 1 },
  connBar: { alignItems: 'center', paddingVertical: 3, backgroundColor: colors.surfaceAlt },
  connText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  composerInput: {
    flex: 1,
    maxHeight: 100,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.glow,
  },
});
