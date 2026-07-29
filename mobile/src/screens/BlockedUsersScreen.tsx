import React, { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Card, EmptyState } from '../components/ui';
import { BlockedUser, fetchBlockedUsers, unblockUser } from '../lib/block';
import { useBlockedUsers } from '../store/blockedUsers';
import { apiBaseURL } from '../api/client';
import { colors, gradients, radius, spacing } from '../theme';

/**
 * Manage the people you've blocked.
 *
 * Blocking existed everywhere (map, chat, profiles) but there was no way back:
 * once blocked, a rider vanished from every surface, including the ones you'd
 * need to reach their profile and undo it. That made an angry tap permanent.
 */
export default function BlockedUsersScreen() {
  const [users, setUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const { refresh: refreshBlockedIds } = useBlockedUsers();

  const load = useCallback(async () => {
    try {
      setUsers(await fetchBlockedUsers());
    } catch {
      // keep whatever we had; the pull-to-refresh is the retry
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onUnblock(u: BlockedUser) {
    Alert.alert('Engeli kaldır', `${u.name} tekrar sana mesaj gönderebilecek ve haritada görünecek.`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Engeli kaldır',
        onPress: async () => {
          setBusy(u.id);
          try {
            await unblockUser(u.id);
            setUsers((prev) => prev.filter((x) => x.id !== u.id));
            await refreshBlockedIds();
          } catch {
            Alert.alert('Hata', 'Engel kaldırılamadı, tekrar dene.');
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.primary}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      {loading ? (
        // Skeleton rather than an empty state: telling someone they've blocked
        // nobody while the list is still loading is a lie they might act on.
        <Card>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.row, i > 0 && styles.divider]}>
              <View style={styles.skelAvatar} />
              <View style={styles.flex}>
                <View style={styles.skelLine} />
              </View>
            </View>
          ))}
        </Card>
      ) : users.length === 0 ? (
        <Card>
          <EmptyState
            compact
            icon="shield-check-outline"
            title="Engellenen kimse yok"
            hint="Birini engellersen burada listelenir ve buradan geri alabilirsin."
          />
        </Card>
      ) : (
        <>
          <Text style={styles.intro}>
            Engellediğin sürücüler sana mesaj gönderemez, haritada ve akışta görünmez.
          </Text>
          <Card>
            {users.map((u, i) => (
              <View key={u.id} style={[styles.row, i > 0 && styles.divider]}>
                {u.avatar_url ? (
                  <Image source={{ uri: apiBaseURL() + u.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={gradients.primary} style={styles.avatar}>
                    <Text style={styles.avatarText}>{u.name?.charAt(0).toUpperCase() ?? '?'}</Text>
                  </LinearGradient>
                )}
                <Text style={styles.name} numberOfLines={1}>
                  {u.name}
                </Text>
                <Pressable
                  style={[styles.unblockBtn, busy === u.id && styles.unblockBusy]}
                  onPress={() => onUnblock(u)}
                  disabled={busy === u.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${u.name} engelini kaldır`}
                >
                  <MaterialCommunityIcons name="account-check-outline" size={16} color={colors.primary} />
                  <Text style={styles.unblockText}>Engeli kaldır</Text>
                </Pressable>
              </View>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  intro: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  name: { color: colors.text, fontWeight: '700', fontSize: 15, flex: 1 },
  unblockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  unblockBusy: { opacity: 0.5 },
  unblockText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  skelAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceAlt },
  skelLine: { height: 14, borderRadius: 7, backgroundColor: colors.surfaceAlt, width: '55%' },
});
