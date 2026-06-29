import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useHeaderHeight } from '@react-navigation/elements';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EventsStackParams } from '../navigation/RootNavigator';
import { EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, apiBaseURL, TOKEN_KEY } from '../api/client';
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
  const [connected, setConnected] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const closed = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

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

  const connectWS = useCallback(async () => {
    if (closed.current) return;
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const wsUrl = `${apiBaseURL().replace(/^http/, 'ws')}/api/events/${code}/ws?token=${token}`;
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => {
      const reconnected = reconnectAttempts.current > 0;
      reconnectAttempts.current = 0;
      setConnected(true);
      if (reconnected) loadMessages();
    };
    socket.onclose = () => {
      setConnected(false);
      if (closed.current) return;
      reconnectAttempts.current += 1;
      if (reconnectAttempts.current > 8) return;
      const delay = Math.min(1000 * reconnectAttempts.current, 5000);
      reconnectTimer.current = setTimeout(() => connectWS(), delay);
    };
    socket.onmessage = (e) => {
      try {
        const m: ChatMsg = JSON.parse(e.data);
        if (m.id == null) return;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      } catch {
        // ignore malformed frames
      }
    };
  }, [code, loadMessages]);

  useEffect(() => {
    closed.current = false;
    reconnectAttempts.current = 0;
    loadMessages();
    connectWS();
    return () => {
      closed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      detachSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function detachSocket() {
    const s = ws.current;
    if (s) {
      s.onopen = null;
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      s.close();
    }
    ws.current = null;
  }

  function send() {
    const body = draft.trim();
    if (!body || ws.current?.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({ body }));
    setDraft('');
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
                {!mine ? <Text style={styles.msgAuthor}>{m.name}</Text> : null}
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
