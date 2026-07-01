import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, Card, TextField } from '../components/ui';
import { BIKE_LABELS, BIKE_TYPES, bikeLabel, LICENSE_LABELS, LICENSE_TYPES, licenseLabel } from '../lib/rider';
import { getEmergencyContact, setEmergencyContact } from '../lib/emergency';
import { PostDetail, DetailPost } from '../components/PostDetail';
import { replayOnboarding } from '../components/OnboardingTour';
import { removeFromFeedCache } from './FeedScreen';
import { AvatarViewer } from '../components/AvatarViewer';
import { RiderChips } from '../components/RiderChips';
import { ProgressBar } from '../components/ProgressBar';
import { LevelInfoButton } from '../components/LevelInfoButton';
import { tierMeta, RiderLevel } from '../lib/rewards';
import { useAuth, User } from '../store/auth';
import { goOffline } from '../lib/presence';
import { ProfileStackParams } from '../navigation/RootNavigator';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Reward = { id: number; type: string; description: string; showcased: boolean; tier?: string; xp?: number };
type SeasonEntry = { user_id: number; name: string; avatar_url?: string; season_xp: number };
type LeaderEntry = {
  user_id: number;
  name: string;
  avatar_url?: string;
  total_distance: number;
  ride_count: number;
  avg_speed?: number;
};
type RecapStat = { week_start: string; distance: number; duration_seconds: number; avg_speed: number; ride_count: number };
type Recap = { week: RecapStat; prev_week: RecapStat };

export default function ProfileScreen() {
  const { user, signOut, updateUser } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<ProfileStackParams>>();
  const { width } = useWindowDimensions();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [leaders, setLeaders] = useState<LeaderEntry[]>([]);
  const [following, setFollowing] = useState<LeaderEntry[]>([]);
  const [lbScope, setLbScope] = useState<'following' | 'global' | 'season'>('following');
  const [seasonLeaders, setSeasonLeaders] = useState<SeasonEntry[]>([]);
  const [level, setLevel] = useState<RiderLevel | null>(null);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [posts, setPosts] = useState<DetailPost[]>([]);
  const [viewer, setViewer] = useState<DetailPost | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState({ bio: '', postCount: 0, followerCount: 0, followingCount: 0 });
  const [zoomUri, setZoomUri] = useState<string | null>(null);
  const [editRider, setEditRider] = useState(false);
  const [riderLicense, setRiderLicense] = useState('');
  const [riderBike, setRiderBike] = useState('');
  const [savingRider, setSavingRider] = useState(false);
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [editEmergency, setEditEmergency] = useState(false);
  const [emergencyInput, setEmergencyInput] = useState('');
  const [savingLoc, setSavingLoc] = useState(false);

  const thumb = (width - spacing.md * 2 - spacing.xs * 2) / 3;
  const showcased = rewards.filter((r) => r.showcased);

  const load = useCallback(async () => {
    getEmergencyContact().then(setEmergencyPhone).catch(() => {});
    try {
      // allSettled (not all): one failing endpoint must never blank the rest of
      // the profile. A missing optional section (e.g. recap) just renders empty.
      const [r, l, p, fl, rc, u, sm, sl] = await Promise.allSettled([
        api.get('/api/rewards'),
        api.get('/api/leaderboard/top'),
        api.get('/api/posts/mine'),
        api.get('/api/leaderboard/following'),
        api.get('/api/rides/recap'),
        user ? api.get(`/api/users/${user.id}`) : Promise.resolve(null),
        api.get('/api/rewards/summary'),
        api.get('/api/leaderboard/season'),
      ]);
      const val = (s: PromiseSettledResult<any>) => (s.status === 'fulfilled' ? s.value : null);
      const rv = val(r), lv = val(l), pv = val(p), flv = val(fl), rcv = val(rc), uv = val(u);
      const smv = val(sm), slv = val(sl);
      if (rv) setRewards(rv.data.rewards ?? []);
      if (lv) setLeaders(lv.data.leaderboard ?? []);
      if (pv) setPosts(pv.data.posts ?? []);
      if (flv) setFollowing(flv.data.leaderboard ?? []);
      if (rcv) setRecap(rcv.data ?? null);
      if (smv) setLevel(smv.data ?? null);
      if (slv) setSeasonLeaders(slv.data.leaderboard ?? []);
      if (uv?.data) {
        const u = uv;
        setStats({
          bio: u.data.bio ?? '',
          postCount: u.data.post_count ?? 0,
          followerCount: u.data.follower_count ?? 0,
          followingCount: u.data.following_count ?? 0,
        });
        // Keep the cached user fresh (e.g. sessions from before these fields
        // shipped, or edits made on another device). Store undefined (not '')
        // for absent fields so the cache matches the User type and server truth.
        const fresh: Partial<User> = {};
        if (u.data.username && u.data.username !== user?.username) fresh.username = u.data.username;
        if ((u.data.bio ?? '') !== (user?.bio ?? '')) fresh.bio = u.data.bio || undefined;
        if ((u.data.license_type ?? '') !== (user?.license_type ?? '')) fresh.license_type = u.data.license_type || undefined;
        if ((u.data.bike_type ?? '') !== (user?.bike_type ?? '')) fresh.bike_type = u.data.bike_type || undefined;
        if (typeof u.data.show_garage === 'boolean' && u.data.show_garage !== user?.show_garage) fresh.show_garage = u.data.show_garage;
        if (typeof u.data.share_live_location === 'boolean' && u.data.share_live_location !== user?.share_live_location) fresh.share_live_location = u.data.share_live_location;
        if (Object.keys(fresh).length > 0) updateUser(fresh);
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

  function openRiderEdit() {
    setRiderLicense(user?.license_type ?? '');
    setRiderBike(user?.bike_type ?? '');
    setEditRider(true);
  }

  async function saveRider() {
    if (!user) return;
    try {
      setSavingRider(true);
      await api.put(`/api/users/${user.id}`, { license_type: riderLicense, bike_type: riderBike });
      await updateUser({ license_type: riderLicense, bike_type: riderBike });
      setEditRider(false);
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSavingRider(false);
    }
  }

  function openEmergencyEdit() {
    setEmergencyInput(emergencyPhone);
    setEditEmergency(true);
  }

  async function saveEmergency() {
    await setEmergencyContact(emergencyInput);
    setEmergencyPhone(emergencyInput.trim());
    setEditEmergency(false);
  }

  async function toggleLocationSharing(next: boolean) {
    if (!user || savingLoc) return;
    try {
      setSavingLoc(true);
      await api.put(`/api/users/${user.id}`, { share_live_location: next });
      await updateUser({ share_live_location: next });
      // Turning it off should remove us from others' maps right away.
      if (!next) goOffline();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSavingLoc(false);
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
          <Text style={styles.username}>@{user?.username || 'kullanıcı_adı'}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          {stats.bio ? <Text style={styles.bio}>{stats.bio}</Text> : null}

          <Pressable style={styles.riderRow} onPress={openRiderEdit} hitSlop={8}>
            {licenseLabel(user?.license_type) || bikeLabel(user?.bike_type) ? (
              <>
                <RiderChips licenseType={user?.license_type} bikeType={user?.bike_type} style={styles.riderChipsInline} />
                <MaterialCommunityIcons name="pencil" size={13} color={colors.textMuted} />
              </>
            ) : (
              <Text style={styles.riderHint}>Ehliyet ve motor türünü ekle →</Text>
            )}
          </Pressable>

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statNum}>{stats.postCount}</Text>
              <Text style={styles.statLabel}>Gönderi</Text>
            </View>
            <Pressable style={styles.statItem} onPress={() => navigation.navigate('Follows')} hitSlop={8}>
              <Text style={styles.statNum}>{stats.followerCount}</Text>
              <Text style={styles.statLabel}>Takipçi</Text>
            </Pressable>
            <Pressable style={styles.statItem} onPress={() => navigation.navigate('Follows')} hitSlop={8}>
              <Text style={styles.statNum}>{stats.followingCount}</Text>
              <Text style={styles.statLabel}>Takip</Text>
            </Pressable>
          </View>

          <Pressable style={styles.editBtn} onPress={() => navigation.navigate('EditProfile')} hitSlop={8}>
            <MaterialCommunityIcons name="account-edit" size={16} color={colors.primary} />
            <Text style={styles.editBtnText}>Profili Düzenle</Text>
          </Pressable>

          {showcased.length > 0 && (
            <View style={styles.badges}>
              {showcased.map((r) => {
                const tm = tierMeta(r.tier);
                return (
                  <View key={r.id} style={[styles.chip, { borderColor: tm.color }]}>
                    <MaterialCommunityIcons name="medal" size={14} color={tm.color} />
                    <Text style={styles.chipText}>{r.description || r.type}</Text>
                  </View>
                );
              })}
            </View>
          )}
        </LinearGradient>

        <View style={styles.quickRow}>
          <QuickTile icon="history" label="Sürüşlerim" onPress={() => navigation.navigate('Rides')} />
          <QuickTile icon="map-marker-path" label="Rotalarım" onPress={() => navigation.navigate('RoutesList')} />
          <QuickTile icon="garage-variant" label="Garaj" onPress={() => navigation.navigate('Garage')} />
          <QuickTile icon="trophy-outline" label="Meydan Okuma" onPress={() => navigation.navigate('Challenges')} />
        </View>

        <SectionTitle icon="chart-box" title="Haftalık Özet" />
        <Card>
          {recap && (recap.week.ride_count > 0 || recap.prev_week.ride_count > 0) ? (
            <RecapBody recap={recap} />
          ) : (
            <Text style={styles.muted}>Bu hafta henüz sürüş kaydın yok. Hadi bir tura çık! 🏍️</Text>
          )}
        </Card>

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

        {level && (
          <>
            <View style={styles.sectionRowBetween}>
              <SectionTitle icon="star-four-points" title="Seviye" />
              <LevelInfoButton />
            </View>
            <Card style={styles.levelCard}>
              <View style={styles.levelBadge}>
                <Text style={styles.levelNum}>{level.level}</Text>
                <Text style={styles.levelNumLabel}>SVY</Text>
              </View>
              <View style={styles.flex}>
                <View style={styles.levelTopRow}>
                  <Text style={styles.levelXp}>{level.xp} XP</Text>
                  <Text style={styles.seasonXp}>Sezon: {level.season_xp} XP</Text>
                </View>
                <ProgressBar
                  fraction={level.level_span > 0 ? level.level_into / level.level_span : 0}
                  color={colors.accent}
                />
                <Text style={styles.levelHint}>
                  Sonraki seviyeye {Math.max(0, level.level_span - level.level_into)} XP
                </Text>
              </View>
            </Card>
          </>
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
              {showcased.map((r) => {
                const tm = tierMeta(r.tier);
                return (
                  <View key={r.id} style={[styles.chip, { borderColor: tm.color }]}>
                    <MaterialCommunityIcons name="medal" size={14} color={tm.color} />
                    <Text style={styles.chipText}>{r.description || r.type}</Text>
                  </View>
                );
              })}
            </View>
          )}
        </Card>

        <SectionTitle icon="podium" title="Liderlik Tablosu" />
        <View style={styles.segment}>
          <SegBtn label="Takip" active={lbScope === 'following'} onPress={() => setLbScope('following')} />
          <SegBtn label="Global" active={lbScope === 'global'} onPress={() => setLbScope('global')} />
          <SegBtn label="Sezon" active={lbScope === 'season'} onPress={() => setLbScope('season')} />
        </View>
        <Card>
          {(() => {
            if (lbScope === 'season') {
              if (seasonLeaders.length === 0) {
                return <Text style={styles.muted}>Bu ay henüz XP kazanan yok.</Text>;
              }
              return seasonLeaders.map((l, i) => (
                <SeasonRow key={l.user_id} entry={l} rank={i} isLast={i === seasonLeaders.length - 1} isMe={l.user_id === user?.id} />
              ));
            }
            const list = lbScope === 'following' ? following : leaders;
            if (list.length === 0) {
              return <Text style={styles.muted}>Veri yok.</Text>;
            }
            return list.map((l, i) => (
              <LeaderRow key={l.user_id} entry={l} rank={i} isLast={i === list.length - 1} isMe={l.user_id === user?.id} />
            ));
          })()}
        </Card>

        <SectionTitle icon="map-marker-account" title="Konum & Gizlilik" />
        <Card style={styles.emRow}>
          <MaterialCommunityIcons name="map-marker-radius" size={22} color={colors.primary} />
          <View style={styles.flex}>
            <Text style={styles.emTitle}>Haritada Görün</Text>
            <Text style={styles.muted}>
              Açıkken yakındaki sürücüler seni haritada görebilir (konumun yaklaşık gösterilir).
            </Text>
          </View>
          <Switch
            value={!!user?.share_live_location}
            onValueChange={toggleLocationSharing}
            disabled={savingLoc}
            trackColor={{ false: colors.surfaceAlt, true: colors.primary }}
            thumbColor="#fff"
          />
        </Card>

        <SectionTitle icon="shield-alert-outline" title="Güvenlik" />
        <Pressable onPress={openEmergencyEdit}>
          <Card style={styles.emRow}>
            <MaterialCommunityIcons name="phone-alert" size={22} color={colors.primary} />
            <View style={styles.flex}>
              <Text style={styles.emTitle}>Acil Durum Kişisi</Text>
              <Text style={styles.muted}>
                {emergencyPhone || 'Kayıtlı değil — kaza algılandığında SMS taslağı için ekle'}
              </Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
          </Card>
        </Pressable>

        <Pressable onPress={replayOnboarding}>
          <Card style={styles.emRow}>
            <MaterialCommunityIcons name="compass-outline" size={22} color={colors.primary} />
            <View style={styles.flex}>
              <Text style={styles.emTitle}>Uygulama Turu</Text>
              <Text style={styles.muted}>Sekmeleri ve ana özellikleri tanıtan turu tekrar izle</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
          </Card>
        </Pressable>

        <View style={{ height: spacing.lg }} />
        <Button title="Çıkış Yap" variant="ghost" icon="logout" onPress={signOut} />
      </ScrollView>

      <PostDetail
        post={viewer}
        onClose={() => setViewer(null)}
        onDeleted={(id) => {
          setPosts((ps) => ps.filter((p) => p.id !== id));
          setStats((s) => ({ ...s, postCount: Math.max(0, s.postCount - 1) }));
          removeFromFeedCache(id);
        }}
      />

      <AvatarViewer uri={zoomUri} onClose={() => setZoomUri(null)} />

      {/* Edit emergency contact (device-only; never sent to the backend) */}
      <Modal visible={editEmergency} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setEditEmergency(false)}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setEditEmergency(false)}>
            <Pressable style={styles.usernameSheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Acil Durum Kişisi</Text>
              <Text style={styles.muted}>
                Kaza algılandığında bu numaraya konumunu içeren SMS taslağı hazırlanır. Numara yalnız bu cihazda saklanır.
              </Text>
              <TextField
                icon="phone"
                placeholder="+90 5xx xxx xx xx"
                value={emergencyInput}
                onChangeText={setEmergencyInput}
                keyboardType="phone-pad"
                autoFocus
              />
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveEmergency} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Edit rider profile (license + bike type) */}
      <Modal visible={editRider} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setEditRider(false)}>
        <Pressable style={styles.backdrop} onPress={() => setEditRider(false)}>
          <Pressable style={styles.usernameSheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Sürücü Profili</Text>
            <Text style={styles.muted}>Sana uygun rota ve etkinlik önerileri için kullanılır.</Text>

            <Text style={styles.pickLabel}>Ehliyet</Text>
            <View style={styles.pillRow}>
              {LICENSE_TYPES.map((t) => (
                <Pressable
                  key={t}
                  style={[styles.pill, riderLicense === t && styles.pillOn]}
                  onPress={() => setRiderLicense((cur) => (cur === t ? '' : t))}
                >
                  <Text style={[styles.pillText, riderLicense === t && styles.pillTextOn]}>{LICENSE_LABELS[t]}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.pickLabel}>Motor Türü</Text>
            <View style={styles.pillRow}>
              {BIKE_TYPES.map((t) => (
                <Pressable
                  key={t}
                  style={[styles.pill, riderBike === t && styles.pillOn]}
                  onPress={() => setRiderBike((cur) => (cur === t ? '' : t))}
                >
                  <Text style={[styles.pillText, riderBike === t && styles.pillTextOn]}>{BIKE_LABELS[t]}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ height: spacing.sm }} />
            <Button title="Kaydet" icon="content-save" onPress={saveRider} loading={savingRider} />
          </Pressable>
        </Pressable>
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
            const tm = tierMeta(r.tier);
            return (
              <Pressable key={r.id} style={styles.manageRow} onPress={() => toggle(r.type)}>
                <MaterialCommunityIcons name="medal" size={20} color={tm.color} />
                <View style={styles.flex}>
                  <Text style={styles.manageName}>{r.description || r.type}</Text>
                  <Text style={[styles.manageTier, { color: tm.color }]}>
                    {tm.label}
                    {r.xp ? ` · ${r.xp} XP` : ''}
                  </Text>
                </View>
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

// fmtDuration renders a second count as a compact Turkish "Xs Ydk" string.
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}s ${m}dk`;
  return `${m}dk`;
}

// RecapBody shows this week's four headline metrics plus a glance at last week.
function RecapBody({ recap }: { recap: Recap }) {
  const w = recap.week;
  const p = recap.prev_week;
  const tiles: { icon: any; label: string; value: string }[] = [
    { icon: 'map-marker-distance', label: 'Mesafe', value: `${w.distance.toFixed(1)} km` },
    { icon: 'clock-outline', label: 'Süre', value: fmtDuration(w.duration_seconds) },
    { icon: 'speedometer', label: 'Ort. Hız', value: `${w.avg_speed.toFixed(0)} km/s` },
    { icon: 'motorbike', label: 'Sürüş', value: String(w.ride_count) },
  ];
  return (
    <>
      <View style={styles.recapGrid}>
        {tiles.map((t) => (
          <View key={t.label} style={styles.recapTile}>
            <MaterialCommunityIcons name={t.icon} size={20} color={colors.primary} />
            <Text style={styles.recapValue}>{t.value}</Text>
            <Text style={styles.recapLabel}>{t.label}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.recapCompare}>
        Geçen hafta: {p.distance.toFixed(1)} km • {p.ride_count} sürüş
      </Text>
    </>
  );
}

// SegBtn is one option of the leaderboard scope segmented control.
function SegBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.segBtn, active && styles.segBtnOn]} onPress={onPress} hitSlop={4}>
      <Text style={[styles.segText, active && styles.segTextOn]}>{label}</Text>
    </Pressable>
  );
}

// LeaderRow renders a single ranked rider; the caller's own row is highlighted.
function LeaderRow({ entry, rank, isLast, isMe }: { entry: LeaderEntry; rank: number; isLast: boolean; isMe: boolean }) {
  return (
    <View style={[styles.leaderRow, !isLast && styles.leaderDivider, isMe && styles.leaderMe]}>
      <View style={[styles.rankBadge, { backgroundColor: MEDALS[rank] ?? colors.surfaceAlt }]}>
        <Text style={[styles.rankText, rank > 2 && { color: colors.textMuted }]}>{rank + 1}</Text>
      </View>
      {entry.avatar_url ? (
        <Image source={{ uri: apiBaseURL() + entry.avatar_url }} style={styles.leaderAvatar} />
      ) : (
        <LinearGradient colors={gradients.primary} style={styles.leaderAvatar}>
          <Text style={styles.leaderAvatarText}>{entry.name?.charAt(0).toUpperCase() ?? '?'}</Text>
        </LinearGradient>
      )}
      <View style={styles.flex}>
        <Text style={[styles.leaderName, isMe && styles.leaderNameMe]} numberOfLines={1}>
          {entry.name}{isMe ? ' (Sen)' : ''}
        </Text>
        <Text style={styles.leaderSub}>{entry.ride_count} sürüş</Text>
      </View>
      <Text style={styles.leaderDist}>{entry.total_distance.toFixed(1)} km</Text>
    </View>
  );
}

// SeasonRow ranks a rider by XP earned this calendar month.
function SeasonRow({ entry, rank, isLast, isMe }: { entry: SeasonEntry; rank: number; isLast: boolean; isMe: boolean }) {
  return (
    <View style={[styles.leaderRow, !isLast && styles.leaderDivider, isMe && styles.leaderMe]}>
      <View style={[styles.rankBadge, { backgroundColor: MEDALS[rank] ?? colors.surfaceAlt }]}>
        <Text style={[styles.rankText, rank > 2 && { color: colors.textMuted }]}>{rank + 1}</Text>
      </View>
      {entry.avatar_url ? (
        <Image source={{ uri: apiBaseURL() + entry.avatar_url }} style={styles.leaderAvatar} />
      ) : (
        <LinearGradient colors={gradients.primary} style={styles.leaderAvatar}>
          <Text style={styles.leaderAvatarText}>{entry.name?.charAt(0).toUpperCase() ?? '?'}</Text>
        </LinearGradient>
      )}
      <View style={styles.flex}>
        <Text style={[styles.leaderName, isMe && styles.leaderNameMe]} numberOfLines={1}>
          {entry.name}{isMe ? ' (Sen)' : ''}
        </Text>
        <Text style={styles.leaderSub}>bu ay</Text>
      </View>
      <Text style={[styles.leaderDist, { color: colors.accent }]}>{entry.season_xp} XP</Text>
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
  username: { color: colors.primary, fontWeight: '700', marginTop: 2 },
  email: { color: colors.textMuted, marginTop: 2 },
  bio: { color: colors.text, textAlign: 'center', marginTop: spacing.sm, paddingHorizontal: spacing.lg, lineHeight: 19 },
  riderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm, flexWrap: 'wrap', justifyContent: 'center' },
  // The shared RiderChips row carries its own top margin; cancel it here since
  // the surrounding Pressable already provides the spacing.
  riderChipsInline: { marginTop: 0 },
  riderHint: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  pickLabel: { color: colors.text, fontWeight: '800', fontSize: 13, marginTop: spacing.md },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  pillOn: { borderColor: colors.primary, backgroundColor: 'rgba(255,106,26,0.15)' },
  pillText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  pillTextOn: { color: colors.primary },
  flex: { flex: 1 },
  emRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  emTitle: { color: colors.text, fontWeight: '800' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  usernameSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  statsRow: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    justifyContent: 'space-around',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  statItem: { alignItems: 'center', gap: 2, flex: 1 },
  statNum: { color: colors.text, fontWeight: '900', fontSize: 18 },
  statLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  editBtnText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
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
  leaderMe: { backgroundColor: 'rgba(255,106,26,0.08)', borderRadius: radius.sm, marginHorizontal: -spacing.xs, paddingHorizontal: spacing.xs },
  rankBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  rankText: { color: '#0A0E16', fontWeight: '900', fontSize: 13 },
  leaderAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  leaderAvatarText: { color: '#fff', fontWeight: '900', fontSize: 14 },
  leaderName: { color: colors.text, fontWeight: '600' },
  leaderNameMe: { color: colors.primary, fontWeight: '800' },
  leaderSub: { color: colors.textMuted, fontSize: 12 },
  leaderDist: { color: colors.primary, fontWeight: '800', marginLeft: spacing.sm },
  // Weekly recap card.
  recapGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  recapTile: { width: '50%', alignItems: 'center', gap: 2, paddingVertical: spacing.sm },
  recapValue: { color: colors.text, fontWeight: '900', fontSize: 18 },
  recapLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  recapCompare: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: spacing.xs },
  // Leaderboard scope toggle.
  segment: { flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: 999, padding: 3, borderWidth: 1, borderColor: colors.border },
  segBtn: { flex: 1, paddingVertical: spacing.sm, alignItems: 'center', borderRadius: 999 },
  segBtnOn: { backgroundColor: colors.primary },
  segText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  segTextOn: { color: '#fff' },
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
  manageTier: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  levelCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  levelBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  levelNum: { color: colors.accent, fontSize: 22, fontWeight: '900', lineHeight: 24 },
  levelNumLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  levelTopRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  levelXp: { color: colors.text, fontWeight: '900', fontSize: 15 },
  seasonXp: { color: colors.textMuted, fontWeight: '700', fontSize: 12 },
  levelHint: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  manageName: { color: colors.text, flex: 1, fontWeight: '600' },
});
