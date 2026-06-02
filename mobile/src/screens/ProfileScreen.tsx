import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, Card, TextField } from '../components/ui';
import { PostDetail, DetailPost } from '../components/PostDetail';
import { AvatarViewer } from '../components/AvatarViewer';
import { useAuth } from '../store/auth';
import { ProfileStackParams } from '../navigation/RootNavigator';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Reward = { id: number; type: string; description: string; showcased: boolean };
type LeaderEntry = { user_id: number; name: string; total_distance: number; ride_count: number };

export default function ProfileScreen() {
  const { user, signOut, updateUser } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<ProfileStackParams>>();
  const { width } = useWindowDimensions();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [leaders, setLeaders] = useState<LeaderEntry[]>([]);
  const [posts, setPosts] = useState<DetailPost[]>([]);
  const [viewer, setViewer] = useState<DetailPost | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [editUsername, setEditUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameErr, setUsernameErr] = useState<string | null>(null);
  const [savingUsername, setSavingUsername] = useState(false);
  const [zoomUri, setZoomUri] = useState<string | null>(null);

  const thumb = (width - spacing.md * 2 - spacing.xs * 2) / 3;
  const showcased = rewards.filter((r) => r.showcased);

  const load = useCallback(async () => {
    try {
      const reqs: Promise<any>[] = [
        api.get('/api/rewards'),
        api.get('/api/leaderboard/top'),
        api.get('/api/posts/mine'),
      ];
      if (user) reqs.push(api.get(`/api/users/${user.id}`));
      const [r, l, p, u] = await Promise.all(reqs);
      setRewards(r.data.rewards ?? []);
      setLeaders(l.data.leaderboard ?? []);
      setPosts(p.data.posts ?? []);
      // Keep the cached user's username fresh (e.g. sessions from before the
      // username feature shipped, or edits made on another device).
      if (u?.data?.username && u.data.username !== user?.username) {
        updateUser({ username: u.data.username });
      }
    } catch {
      // Silently ignore; screen still renders profile info.
    }
  }, [user, updateUser]);

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

  function changeAvatar() {
    Alert.alert('Profil fotoğrafı', 'Bir kaynak seç', [
      { text: 'Kameradan Çek', onPress: () => pickAvatar('camera') },
      { text: 'Galeriden Seç', onPress: () => pickAvatar('library') },
      { text: 'Vazgeç', style: 'cancel' },
    ]);
  }

  async function pickAvatar(source: 'camera' | 'library') {
    const perm =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('İzin gerekli', source === 'camera' ? 'Kamera izni vermelisin.' : 'Galeri izni vermelisin.');
      return;
    }
    // allowsEditing + 1:1 aspect gives the native square crop UI.
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!res.canceled && res.assets[0]) {
      await uploadAvatar(res.assets[0]);
    }
  }

  async function uploadAvatar(asset: ImagePicker.ImagePickerAsset) {
    if (!user) return;
    try {
      setUploadingAvatar(true);
      const type = asset.mimeType ?? 'image/jpeg';
      const ext = type.split('/')[1] ?? 'jpg';
      const form = new FormData();
      form.append('photo', { uri: asset.uri, name: `avatar.${ext}`, type } as any);
      const { data } = await api.post('/api/feed/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await api.put(`/api/users/${user.id}`, { avatar_url: data.url });
      await updateUser({ avatar_url: data.url });
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    } finally {
      setUploadingAvatar(false);
    }
  }

  function openUsernameEdit() {
    setUsernameInput(user?.username ?? '');
    setUsernameErr(null);
    setEditUsername(true);
  }

  async function saveUsername() {
    if (!user) return;
    const next = usernameInput.trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(next)) {
      setUsernameErr('3-20 karakter olmalı: harf, rakam veya _');
      return;
    }
    if (next === user.username) {
      setEditUsername(false);
      return;
    }
    try {
      setSavingUsername(true);
      setUsernameErr(null);
      await api.put(`/api/users/${user.id}`, { username: next });
      await updateUser({ username: next });
      setEditUsername(false);
    } catch (err) {
      const status = (err as any)?.response?.status;
      setUsernameErr(status === 409 ? 'Bu kullanıcı adı alınmış' : errorMessage(err));
    } finally {
      setSavingUsername(false);
    }
  }

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
          <Pressable
            onPress={() => (user?.avatar_url ? setZoomUri(apiBaseURL() + user.avatar_url) : changeAvatar())}
            disabled={uploadingAvatar}
          >
            {user?.avatar_url ? (
              <Image source={{ uri: apiBaseURL() + user.avatar_url }} style={styles.avatar} />
            ) : (
              <LinearGradient colors={gradients.primary} style={styles.avatar}>
                <Text style={styles.avatarText}>{user?.name?.charAt(0).toUpperCase() ?? 'M'}</Text>
              </LinearGradient>
            )}
            <Pressable style={styles.avatarBadge} onPress={changeAvatar} disabled={uploadingAvatar} hitSlop={8}>
              {uploadingAvatar ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialCommunityIcons name="camera" size={15} color="#fff" />
              )}
            </Pressable>
          </Pressable>
          <Text style={styles.name}>{user?.name}</Text>
          <Pressable style={styles.usernameRow} onPress={openUsernameEdit} hitSlop={8}>
            <Text style={styles.username}>@{user?.username || 'kullanıcı_adı'}</Text>
            <MaterialCommunityIcons name="pencil" size={14} color={colors.textMuted} />
          </Pressable>
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

        <View style={styles.quickRow}>
          <QuickTile icon="history" label="Sürüşlerim" onPress={() => navigation.navigate('Rides')} />
          <QuickTile icon="map-marker-path" label="Rotalarım" onPress={() => navigation.navigate('RoutesList')} />
          <QuickTile icon="account-multiple" label="Takip" onPress={() => navigation.navigate('Follows')} />
        </View>

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

      <AvatarViewer uri={zoomUri} onClose={() => setZoomUri(null)} />

      {/* Edit @username */}
      <Modal visible={editUsername} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setEditUsername(false)}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setEditUsername(false)}>
            <Pressable style={styles.usernameSheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Kullanıcı Adı</Text>
              <Text style={styles.muted}>Benzersiz olmalı. Başkaları seni bununla bulabilir.</Text>
              <TextField
                icon="at"
                placeholder="kullanici_adi"
                value={usernameInput}
                onChangeText={(t) => setUsernameInput(t)}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                maxLength={20}
              />
              {usernameErr ? <Text style={styles.errText}>{usernameErr}</Text> : null}
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveUsername} loading={savingUsername} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

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

// Quick-access tile to a personal collection (history, routes, follows).
function QuickTile({ icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.quickTile, pressed && styles.quickTilePressed]} onPress={onPress}>
      <MaterialCommunityIcons name={icon} size={24} color={colors.primary} />
      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
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
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: spacing.sm - 2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { color: colors.text, fontSize: 22, fontWeight: '900' },
  quickRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  quickTile: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickTilePressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  quickLabel: { color: colors.text, fontWeight: '700', fontSize: 13 },
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  username: { color: colors.primary, fontWeight: '700' },
  email: { color: colors.textMuted, marginTop: 2 },
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  usernameSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  errText: { color: colors.danger, fontWeight: '600', fontSize: 13 },
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
