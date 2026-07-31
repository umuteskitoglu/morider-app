// Bildirim merkezi — the durable record of everything that happened to you.
//
// Before this screen a notification existed only as long as the OS kept its
// banner on screen: miss it and it was gone. Rows here survive, so the bell is
// somewhere a rider can actually go back to.
import React, { useCallback, useLayoutEffect, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';

import { apiBaseURL, errorMessage } from '../api/client';
import { EmptyState } from '../components/ui';
import { timeAgo } from '../lib/datetime';
import { AppNotification, fetchNotifications } from '../lib/notifications';
import { openNotification } from '../lib/notificationRoute';
import { useNotifications } from '../store/notifications';
import { colors, gradients, radius, spacing, type } from '../theme';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// Fallback glyph when a notification has no actor to show a face for (and the
// visual cue for what kind of thing happened).
const ICONS: Record<string, IconName> = {
  dm: 'message-text',
  community_post: 'bullhorn',
  community_join_request: 'account-clock',
  community_approved: 'account-check',
  challenge_invite: 'trophy',
  sos: 'alert',
  follow: 'account-plus',
  post_like: 'heart',
  post_comment: 'comment-text',
  segment_kom: 'flag-checkered',
};

// The screen is registered in four different stacks, so it is typed
// structurally rather than against one stack's params. It only needs
// setOptions: rows navigate through notificationRoute, not this prop.
type Props = { navigation: { setOptions: (options: object) => void } };

export default function NotificationsScreen({ navigation }: Props) {
  const { markRead, markAllRead, refresh } = useNotifications();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchNotifications();
      setItems(list);
      setExhausted(list.length === 0);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Bildirimler yüklenemedi'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || exhausted || items.length === 0) return;
    setLoadingMore(true);
    try {
      const older = await fetchNotifications(items[items.length - 1].id);
      if (older.length === 0) setExhausted(true);
      else setItems((prev) => [...prev, ...older]);
    } catch {
      // Pagination is best effort; pull-to-refresh recovers.
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore, exhausted]);

  useFocusEffect(
    useCallback(() => {
      load();
      refresh();
    }, [load, refresh]),
  );

  const onMarkAll = useCallback(() => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    markAllRead();
  }, [markAllRead]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        items.some((n) => !n.read) ? (
          <Pressable
            onPress={onMarkAll}
            hitSlop={8}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel="Tüm bildirimleri okundu işaretle"
          >
            <Text style={styles.headerBtnText}>Tümünü oku</Text>
          </Pressable>
        ) : null,
    });
  }, [navigation, items, onMarkAll]);

  function open(item: AppNotification) {
    if (!item.read) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
      markRead(item.id);
    }
    openNotification({ ...item.data, type: item.type, entity_id: item.entity_id });
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        onEndReachedThreshold={0.4}
        onEndReached={loadMore}
        ListEmptyComponent={
          loading ? null : error ? (
            <EmptyState icon="wifi-off" title="Bildirimler yüklenemedi" hint={error} />
          ) : (
            <EmptyState
              icon="bell-outline"
              title="Henüz bildirim yok"
              hint={'Biri seni takip ettiğinde, gönderini beğendiğinde\nveya kapışma rekorunu kırdığında burada görürsün.'}
            />
          )
        }
        renderItem={({ item }) => <Row item={item} onPress={() => open(item)} />}
      />
    </View>
  );
}

function Row({ item, onPress }: { item: AppNotification; onPress: () => void }) {
  const others = item.event_count > 1 ? ` ve ${item.event_count - 1} kişi daha` : '';
  return (
    <Pressable
      style={({ pressed }) => [styles.row, !item.read && styles.rowUnread, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${item.body}${others}`}
    >
      {item.actor_avatar ? (
        <Image source={{ uri: apiBaseURL() + item.actor_avatar }} style={styles.avatar} />
      ) : (
        <LinearGradient colors={gradients.surface} style={styles.avatar}>
          <MaterialCommunityIcons
            name={ICONS[item.type] ?? 'bell-outline'}
            size={20}
            color={colors.primary}
          />
        </LinearGradient>
      )}
      <View style={styles.flex}>
        <Text style={styles.title} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.body} numberOfLines={2}>
          {item.body}
          {others}
        </Text>
      </View>
      <View style={styles.meta}>
        <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
        {!item.read ? <View style={styles.dot} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.xs, paddingBottom: spacing.xl, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  rowUnread: { backgroundColor: colors.surfaceAlt },
  rowPressed: { opacity: 0.7 },
  avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  title: { ...type.caption, color: colors.text },
  body: { ...type.body, color: colors.textMuted, marginTop: 2 },
  meta: { alignItems: 'flex-end', gap: 6 },
  time: { ...type.micro, color: colors.textFaint },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  headerBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  headerBtnText: { ...type.micro, color: colors.primary },
});
