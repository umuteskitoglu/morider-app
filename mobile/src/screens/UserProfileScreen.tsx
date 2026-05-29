import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Alert, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { FeedStackParams } from '../navigation/RootNavigator';
import { PostDetail, DetailPost } from '../components/PostDetail';
import { Button } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Badge = { id: number; type: string; description: string };
type FriendState = 'none' | 'pending_out' | 'pending_in' | 'friends';
type Props = NativeStackScreenProps<FeedStackParams, 'UserProfile'>;

export default function UserProfileScreen({ route, navigation }: Props) {
  const { userId, name } = route.params;
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [posts, setPosts] = useState<DetailPost[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [viewer, setViewer] = useState<DetailPost | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [friendState, setFriendState] = useState<FriendState>('none');
  const [requestId, setRequestId] = useState<number | null>(null);

  const isSelf = user?.id === userId;

  const thumb = (width - spacing.md * 2 - spacing.xs * 2) / 3;

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    try {
      const reqs: Promise<any>[] = [
        api.get(`/api/feed/user/${userId}`),
        api.get(`/api/rewards/user/${userId}`),
      ];
      if (!isSelf) reqs.push(api.get(`/api/friends/status/${userId}`));
      const [p, b, s] = await Promise.all(reqs);
      setPosts(p.data.posts ?? []);
      setBadges(b.data.rewards ?? []);
      if (s) {
        setFriendState(s.data.status ?? 'none');
        setRequestId(s.data.request_id ?? null);
      }
    } catch {
      // ignore
    }
  }, [userId, isSelf]);

  async function addFriend() {
    try {
      await api.post('/api/friends/requests', { user_id: userId });
      setFriendState('pending_out');
    } catch (err) {
      Alert.alert('Gönderilemedi', errorMessage(err));
    }
  }

  async function acceptFriend() {
    if (!requestId) return;
    try {
      await api.post(`/api/friends/requests/${requestId}/accept`);
      setFriendState('friends');
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    }
  }

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

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <LinearGradient colors={gradients.surface} style={styles.header}>
          <LinearGradient colors={gradients.primary} style={styles.avatar}>
            <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
          </LinearGradient>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.muted}>{posts.length} paylaşım</Text>
          {badges.length > 0 && (
            <View style={styles.badges}>
              {badges.map((b) => (
                <View key={b.id} style={styles.chip}>
                  <Text style={styles.chipIcon}>🏅</Text>
                  <Text style={styles.chipText}>{b.description || b.type}</Text>
                </View>
              ))}
            </View>
          )}
        </LinearGradient>

        {!isSelf && friendState === 'none' && (
          <Button title="Arkadaş Ekle" icon="account-plus" onPress={addFriend} />
        )}
        {!isSelf && friendState === 'pending_out' && (
          <Button title="İstek Gönderildi" variant="ghost" icon="clock-outline" disabled onPress={() => {}} />
        )}
        {!isSelf && friendState === 'pending_in' && (
          <Button title="İsteği Kabul Et" icon="account-check" onPress={acceptFriend} />
        )}
        {!isSelf && friendState === 'friends' && (
          <Button title="Arkadaşsınız" variant="ghost" icon="check" disabled onPress={() => {}} />
        )}

        {posts.length === 0 ? (
          <Text style={styles.empty}>Bu kullanıcının henüz paylaşımı yok.</Text>
        ) : (
          <View style={styles.grid}>
            {posts.map((p) => (
              <Pressable key={p.id} style={[styles.gridItem, { width: thumb, height: thumb }]} onPress={() => setViewer(p)}>
                <Image source={{ uri: apiBaseURL() + p.photos[0] }} style={styles.gridImg} />
                {p.photos.length > 1 && (
                  <View style={styles.multi}>
                    <MaterialCommunityIcons name="image-multiple" size={14} color="#fff" />
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
      <PostDetail post={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  header: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  avatar: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm, ...shadow.glow },
  avatarText: { color: '#fff', fontSize: 34, fontWeight: '900' },
  name: { color: colors.text, fontSize: 22, fontWeight: '900' },
  muted: { color: colors.textMuted, marginTop: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 999,
  },
  chipIcon: { fontSize: 13 },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  gridItem: { borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  gridImg: { width: '100%', height: '100%' },
  multi: { position: 'absolute', top: 4, right: 4 },
});
