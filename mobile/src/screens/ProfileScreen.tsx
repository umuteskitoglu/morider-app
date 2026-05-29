import React, { useCallback, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, Card } from '../components/ui';
import { PostDetail, DetailPost } from '../components/PostDetail';
import { useAuth } from '../store/auth';
import { api, apiBaseURL } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Reward = { id: number; type: string; description: string; showcased: boolean };
type LeaderEntry = { user_id: number; name: string; total_distance: number; ride_count: number };

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { width } = useWindowDimensions();
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [leaders, setLeaders] = useState<LeaderEntry[]>([]);
  const [posts, setPosts] = useState<DetailPost[]>([]);
  const [viewer, setViewer] = useState<DetailPost | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const thumb = (width - spacing.md * 2 - spacing.xs * 2) / 3;
  const showcased = rewards.filter((r) => r.showcased);

  const load = useCallback(async () => {
    try {
      const [r, l, p] = await Promise.all([
        api.get('/api/rewards'),
        api.get('/api/leaderboard/top'),
        api.get('/api/posts/mine'),
      ]);
      setRewards(r.data.rewards ?? []);
      setLeaders(l.data.leaderboard ?? []);
      setPosts(p.data.posts ?? []);
    } catch {
      // Silently ignore; screen still renders profile info.
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

  function openManage() {
    setSelected(showcased.map((r) => r.type));
    setManage(true);
  }

  function toggle(type: string) {
    setSelected((s) => (s.includes(type) ? s.filter((t) => t !== type) : [...s, type]));
  }

  async function saveShowcase() {
    try {
      setSaving(true);
      const { data } = await api.put('/api/rewards/showcase', { types: selected });
      setRewards(data.rewards ?? []);
      setManage(false);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <LinearGradient colors={gradients.surface} style={styles.profile}>
          <LinearGradient colors={gradients.primary} style={styles.avatar}>
            <Text style={styles.avatarText}>{user?.name?.charAt(0).toUpperCase() ?? 'M'}</Text>
          </LinearGradient>
          <Text style={styles.name}>{user?.name}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          {showcased.length > 0 && (
            <View style={styles.badges}>
              {showcased.map((r) => (
                <View key={r.id} style={styles.chip}>
                  <Text style={styles.chipIcon}>🏅</Text>
                  <Text style={styles.chipText}>{r.description || r.type}</Text>
                </View>
              ))}
            </View>
          )}
        </LinearGradient>

        <SectionTitle icon="image-multiple" title="Paylaşımlarım" />
        {posts.length === 0 ? (
          <Card>
            <Text style={styles.muted}>Henüz paylaşım yok. Akış sekmesinden ilk fotoğrafını paylaş! 📸</Text>
          </Card>
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

        <View style={styles.sectionRowBetween}>
          <SectionTitle icon="trophy-variant" title="Rozetlerim" />
          {rewards.length > 0 && (
            <Pressable onPress={openManage} hitSlop={8}>
              <Text style={styles.manageLink}>Tüm Rozetler ({rewards.length})</Text>
            </Pressable>
          )}
        </View>
        <Card>
          {rewards.length === 0 ? (
            <Text style={styles.muted}>Henüz rozet kazanmadın. İlk sürüşünü yap! 🏍️</Text>
          ) : showcased.length === 0 ? (
            <Text style={styles.muted}>Profilinde sergilemek için "Tüm Rozetler"den rozet seç.</Text>
          ) : (
            <View style={styles.chips}>
              {showcased.map((r) => (
                <View key={r.id} style={styles.chip}>
                  <Text style={styles.chipIcon}>🏅</Text>
                  <Text style={styles.chipText}>{r.description || r.type}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>

        <SectionTitle icon="podium" title="Liderlik Tablosu" />
        <Card>
          {leaders.length === 0 ? (
            <Text style={styles.muted}>Veri yok.</Text>
          ) : (
            leaders.map((l, i) => (
              <View key={l.user_id} style={[styles.leaderRow, i < leaders.length - 1 && styles.leaderDivider]}>
                <View style={[styles.rankBadge, { backgroundColor: MEDALS[i] ?? colors.surfaceAlt }]}>
                  <Text style={[styles.rankText, i > 2 && { color: colors.textMuted }]}>{i + 1}</Text>
                </View>
                <Text style={styles.leaderName} numberOfLines={1}>{l.name}</Text>
                <Text style={styles.leaderDist}>{l.total_distance.toFixed(1)} km</Text>
              </View>
            ))
          )}
        </Card>

        <View style={{ height: spacing.lg }} />
        <Button title="Çıkış Yap" variant="ghost" icon="logout" onPress={signOut} />
      </ScrollView>

      <PostDetail post={viewer} onClose={() => setViewer(null)} />

      {/* Manage showcased badges */}
      <Modal visible={manage} animationType="slide" onRequestClose={() => setManage(false)}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Rozetleri Sergile</Text>
          <Pressable onPress={() => setManage(false)} hitSlop={12}>
            <MaterialCommunityIcons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView style={styles.container} contentContainerStyle={styles.manageContent}>
          <Text style={styles.muted}>Profilinde göstermek istediğin rozetleri seç.</Text>
          {rewards.map((r) => {
            const on = selected.includes(r.type);
            return (
              <Pressable key={r.id} style={styles.manageRow} onPress={() => toggle(r.type)}>
                <Text style={styles.manageIcon}>🏅</Text>
                <Text style={styles.manageName}>{r.description || r.type}</Text>
                <MaterialCommunityIcons
                  name={on ? 'star' : 'star-outline'}
                  size={24}
                  color={on ? colors.accent : colors.textMuted}
                />
              </Pressable>
            );
          })}
          <View style={{ height: spacing.md }} />
          <Button title="Kaydet" icon="content-save" onPress={saveShowcase} loading={saving} />
        </ScrollView>
      </Modal>
    </>
  );
}

const MEDALS = ['#FFD24A', '#C7CEDB', '#E08945'];

function SectionTitle({ icon, title }: { icon: any; title: string }) {
  return (
    <View style={styles.sectionRow}>
      <MaterialCommunityIcons name={icon} size={18} color={colors.primary} />
      <Text style={styles.section}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  profile: {
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
  email: { color: colors.textMuted, marginTop: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.md, marginBottom: spacing.xs },
  sectionRowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { color: colors.text, fontWeight: '800', fontSize: 15, letterSpacing: 0.3 },
  manageLink: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  muted: { color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  chipIcon: { fontSize: 14 },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  gridItem: { borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  gridImg: { width: '100%', height: '100%' },
  multi: { position: 'absolute', top: 4, right: 4 },
  leaderRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  leaderDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rankBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: spacing.md },
  rankText: { color: '#0A0E16', fontWeight: '900', fontSize: 13 },
  leaderName: { color: colors.text, flex: 1, fontWeight: '600' },
  leaderDist: { color: colors.primary, fontWeight: '800' },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    paddingTop: spacing.xl,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { color: colors.text, fontWeight: '800', fontSize: 16 },
  manageContent: { padding: spacing.md, gap: spacing.xs },
  manageRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  manageIcon: { fontSize: 18 },
  manageName: { color: colors.text, flex: 1, fontWeight: '600' },
});
