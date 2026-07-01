import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EmptyState } from '../components/ui';
import { ChatStackParams } from '../navigation/RootNavigator';
import { ConversationItem, fetchConversations } from '../lib/chat';
import { apiBaseURL } from '../api/client';
import { formatTime } from '../lib/datetime';
import { colors, gradients, radius, spacing } from '../theme';

export default function ConversationsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ChatStackParams>>();
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await fetchConversations());
    } catch {
      // best effort — keep whatever is on screen
    }
  }, []);

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

  const requests = items.filter((c) => c.is_request);
  const primary = items.filter((c) => !c.is_request);

  function openThread(c: ConversationItem) {
    navigation.navigate('ChatThread', {
      conversationId: c.conversation_id,
      name: c.other_user.name,
      avatarUrl: c.other_user.avatar_url,
    });
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {items.length === 0 ? (
        <View style={styles.empty}>
          <EmptyState
            icon="message-text-outline"
            title="Henüz mesajın yok"
            hint="Haritada yakındaki bir sürücüye dokunup mesaj gönderebilirsin."
          />
        </View>
      ) : (
        <>
          {requests.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Mesaj İstekleri</Text>
              {requests.map((c) => (
                <Row key={c.conversation_id} item={c} onPress={() => openThread(c)} isRequest />
              ))}
            </>
          )}
          {primary.length > 0 && (
            <>
              {requests.length > 0 ? <Text style={styles.sectionTitle}>Mesajlar</Text> : null}
              {primary.map((c) => (
                <Row key={c.conversation_id} item={c} onPress={() => openThread(c)} />
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Row({ item, onPress, isRequest }: { item: ConversationItem; onPress: () => void; isRequest?: boolean }) {
  const preview = item.last_message?.body ?? (isRequest ? 'Seninle sohbet başlatmak istiyor' : 'Sohbeti başlat');
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      {item.other_user.avatar_url ? (
        <Image source={{ uri: apiBaseURL() + item.other_user.avatar_url }} style={styles.avatar} />
      ) : (
        <LinearGradient colors={gradients.primary} style={styles.avatar}>
          <Text style={styles.avatarText}>{item.other_user.name?.charAt(0).toUpperCase() ?? '?'}</Text>
        </LinearGradient>
      )}
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>{item.other_user.name}</Text>
        <Text style={[styles.preview, item.unread_count > 0 && styles.previewUnread]} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      <View style={styles.meta}>
        {item.last_message ? <Text style={styles.time}>{formatTime(item.last_message.created_at)}</Text> : null}
        {item.unread_count > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.unread_count > 9 ? '9+' : item.unread_count}</Text>
          </View>
        ) : null}
        {isRequest ? <MaterialCommunityIcons name="account-clock" size={16} color={colors.accent} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.xs, paddingBottom: spacing.xl },
  empty: { flex: 1, minHeight: 400, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { color: colors.textMuted, fontWeight: '800', fontSize: 12, letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.md, marginBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowPressed: { opacity: 0.7 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 18 },
  flex: { flex: 1 },
  name: { color: colors.text, fontWeight: '800', fontSize: 15 },
  preview: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  previewUnread: { color: colors.text, fontWeight: '700' },
  meta: { alignItems: 'flex-end', gap: 4 },
  time: { color: colors.textMuted, fontSize: 11 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontWeight: '900', fontSize: 11 },
});
