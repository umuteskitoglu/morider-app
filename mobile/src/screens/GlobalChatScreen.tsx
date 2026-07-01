import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';
import { fetchGlobalMessages, GlobalMsg, SlowmodeFrame } from '../lib/chat';
import { useChatSocket } from '../lib/useChatSocket';
import { formatTime } from '../lib/datetime';
import { colors, radius, shadow, spacing } from '../theme';

export default function GlobalChatScreen() {
  const { user } = useAuth();
  const headerHeight = useHeaderHeight();

  const [messages, setMessages] = useState<GlobalMsg[]>([]);
  const [draft, setDraft] = useState('');
  // Seconds remaining under slow mode; 0 = may send. Counts down each second.
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMessages = useCallback(async () => {
    try {
      setMessages(await fetchGlobalMessages());
    } catch {
      // best effort
    }
  }, []);

  const startCooldown = useCallback((ms: number) => {
    const secs = Math.ceil(ms / 1000);
    setCooldown(secs);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, []);

  const { connected, send: sendFrame } = useChatSocket({
    path: '/api/chat/global/ws',
    onMessage: (parsed) => {
      if (parsed?.type === 'slowmode') {
        startCooldown((parsed as SlowmodeFrame).retry_after_ms);
        return;
      }
      const m = parsed as GlobalMsg;
      if (m?.id == null) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    },
    onReconnect: loadMessages,
  });

  useEffect(() => {
    loadMessages();
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, [loadMessages]);

  function send() {
    const body = draft.trim();
    if (!body || cooldown > 0) return;
    if (sendFrame({ body })) setDraft('');
  }

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
            <EmptyState icon="earth" title="Topluluk sohbeti sessiz" hint="İlk mesajı sen yaz — yoldaki herkes görür!" />
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
          placeholder={cooldown > 0 ? `Yavaş mod: ${cooldown}s bekle…` : 'Mesaj yaz…'}
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={1000}
          editable={cooldown === 0}
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
        />
        <Pressable style={[styles.sendBtn, (cooldown > 0 || !draft.trim()) && styles.sendBtnOff]} onPress={send} disabled={cooldown > 0 || !draft.trim()}>
          {cooldown > 0 ? (
            <Text style={styles.cooldownText}>{cooldown}</Text>
          ) : (
            <MaterialCommunityIcons name="send" size={20} color="#fff" />
          )}
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
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.md },
  msgBubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 2 },
  msgBubbleOther: { backgroundColor: colors.surfaceAlt, borderBottomLeftRadius: 2 },
  msgAuthor: { color: colors.accent, fontSize: 11, fontWeight: '800', marginBottom: 1 },
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
  sendBtnOff: { backgroundColor: colors.surfaceAlt },
  cooldownText: { color: colors.textMuted, fontWeight: '900', fontSize: 15 },
});
