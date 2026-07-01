import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { useHeaderHeight } from '@react-navigation/elements';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ChatStackParams } from '../navigation/RootNavigator';
import { EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';
import {
  acceptConversation,
  declineConversation,
  DmMsg,
  fetchDmMessages,
  startConversation,
} from '../lib/chat';
import { useChatSocket } from '../lib/useChatSocket';
import { formatTime } from '../lib/datetime';
import { colors, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<ChatStackParams, 'ChatThread'>;

export default function ChatThreadScreen({ navigation, route }: Props) {
  const { user } = useAuth();
  const headerHeight = useHeaderHeight();
  const paramConvId = route.params.conversationId != null ? Number(route.params.conversationId) : undefined;
  const userId = route.params.userId;

  const [convId, setConvId] = useState<number | undefined>(paramConvId);
  const [messages, setMessages] = useState<DmMsg[]>([]);
  const [status, setStatus] = useState<string>('accepted');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sendingLoc, setSendingLoc] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: route.params.name ?? 'Sohbet' });
  }, [navigation, route.params.name]);

  const loadMessages = useCallback(async (id: number) => {
    try {
      const { messages: msgs, status: st } = await fetchDmMessages(id);
      setMessages(msgs);
      setStatus(st);
    } catch {
      // best effort
    }
  }, []);

  // Resolve the conversation id (creating it from a userId if needed), then load
  // history. The socket opens once convId is set (see useChatSocket below).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id = paramConvId;
      if (id == null && userId != null) {
        try {
          id = (await startConversation(userId)).conversation_id;
        } catch {
          if (!cancelled) setLoading(false);
          return;
        }
      }
      if (id == null || cancelled) {
        if (!cancelled) setLoading(false);
        return;
      }
      setConvId(id);
      await loadMessages(id);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { connected, send: sendFrame } = useChatSocket({
    path: convId != null ? `/api/dm/${convId}/ws` : '',
    enabled: convId != null,
    onMessage: (m: DmMsg) => {
      if (m?.id == null) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      // Any inbound message on a pending thread means it's now live.
      setStatus((s) => (s === 'pending' ? 'accepted' : s));
    },
    onReconnect: () => {
      if (convId != null) loadMessages(convId);
    },
  });

  function send() {
    const body = draft.trim();
    if (!body) return;
    if (sendFrame({ body })) setDraft('');
  }

  async function sendLocation() {
    try {
      setSendingLoc(true);
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        Alert.alert('İzin gerekli', 'Konum göndermek için konum izni vermelisin.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      sendFrame({ body: '📍 Konumumu paylaştım', lat: loc.coords.latitude, lon: loc.coords.longitude });
    } catch {
      Alert.alert('Gönderilemedi', 'Konum alınamadı, tekrar dene.');
    } finally {
      setSendingLoc(false);
    }
  }

  function openLocation(lat: number, lon: number) {
    const url = Platform.select({
      ios: `maps://?q=${lat},${lon}`,
      android: `geo:${lat},${lon}?q=${lat},${lon}`,
    });
    if (url) Linking.openURL(url).catch(() => {});
  }

  async function onAccept() {
    if (convId == null) return;
    try {
      await acceptConversation(convId);
      setStatus('accepted');
    } catch {
      // ignore
    }
  }

  async function onDecline() {
    if (convId == null) return;
    try {
      await declineConversation(convId);
    } catch {
      // ignore
    }
    navigation.goBack();
  }

  // Show accept/decline only when the *other* rider started a still-pending
  // request (their message exists but I haven't replied/accepted yet).
  const isIncomingRequest = status === 'pending' && messages.some((m) => m.sender_id !== user?.id);

  const data = messages.slice().reverse();

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      {isIncomingRequest && (
        <View style={styles.requestBar}>
          <Text style={styles.requestText}>Bu bir mesaj isteği. Kabul edersen sohbet başlar.</Text>
          <View style={styles.requestBtns}>
            <Pressable style={[styles.reqBtn, styles.reqDecline]} onPress={onDecline}>
              <Text style={styles.reqDeclineText}>Sil</Text>
            </Pressable>
            <Pressable style={[styles.reqBtn, styles.reqAccept]} onPress={onAccept}>
              <Text style={styles.reqAcceptText}>Kabul Et</Text>
            </Pressable>
          </View>
        </View>
      )}

      <FlatList
        data={data}
        inverted={data.length > 0}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={data.length === 0 ? styles.emptyWrap : styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <EmptyState icon="message-outline" title="Sohbete başla" hint="İlk mesajı gönder veya konumunu paylaş." />
          </View>
        }
        renderItem={({ item: m }) => {
          const mine = m.sender_id === user?.id;
          const hasLoc = m.lat != null && m.lon != null;
          return (
            <View style={[styles.msgRow, mine && styles.msgRowMine]}>
              <View style={[styles.msgBubble, mine ? styles.msgBubbleMine : styles.msgBubbleOther]}>
                <Text style={styles.msgBody}>{m.body}</Text>
                {hasLoc && (
                  <Pressable style={styles.locChip} onPress={() => openLocation(m.lat as number, m.lon as number)}>
                    <MaterialCommunityIcons name="map-marker" size={16} color={colors.accent} />
                    <Text style={styles.locChipText}>Konumu Gör</Text>
                  </Pressable>
                )}
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
        <Pressable style={styles.locBtn} onPress={sendLocation} disabled={sendingLoc}>
          {sendingLoc ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <MaterialCommunityIcons name="map-marker-radius" size={22} color={colors.primary} />
          )}
        </Pressable>
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Mesaj yaz…"
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={1000}
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
        />
        <Pressable style={[styles.sendBtn, !draft.trim() && styles.sendBtnOff]} onPress={send} disabled={!draft.trim()}>
          <MaterialCommunityIcons name="send" size={20} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  list: { padding: spacing.md, gap: spacing.xs },
  emptyWrap: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  requestBar: { padding: spacing.md, backgroundColor: colors.surfaceAlt, borderBottomWidth: 1, borderBottomColor: colors.border, gap: spacing.sm },
  requestText: { color: colors.textMuted, fontSize: 13 },
  requestBtns: { flexDirection: 'row', gap: spacing.sm },
  reqBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, alignItems: 'center' },
  reqDecline: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  reqDeclineText: { color: colors.textMuted, fontWeight: '800' },
  reqAccept: { backgroundColor: colors.primary },
  reqAcceptText: { color: '#fff', fontWeight: '800' },
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.md },
  msgBubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 2 },
  msgBubbleOther: { backgroundColor: colors.surfaceAlt, borderBottomLeftRadius: 2 },
  msgBody: { color: '#fff', fontSize: 15, paddingRight: 3 },
  msgTime: { color: 'rgba(255,255,255,0.6)', fontSize: 10, alignSelf: 'flex-end', marginTop: 1 },
  locChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingVertical: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  locChipText: { color: colors.accent, fontWeight: '800', fontSize: 12 },
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
  locBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
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
});
