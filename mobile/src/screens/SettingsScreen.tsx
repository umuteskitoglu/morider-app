import React, { useCallback, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { replayOnboarding } from '../components/OnboardingTour';
import { composeTestSMS, getEmergencyContact, setEmergencyContact } from '../lib/emergency';
import { deleteAccount } from '../lib/account';
import { goOffline } from '../lib/presence';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'Settings'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

/**
 * One place for everything that is a setting.
 *
 * These controls used to be spread across three screens: name/bio/username and
 * two privacy switches in EditProfile, a third privacy switch and the emergency
 * contact as cards in the middle of ProfileScreen, sign-out at the bottom of a
 * long scroll below the leaderboard. Nobody could answer "have I checked my
 * privacy settings?" — which is a problem in an app that shares live location.
 */
export default function SettingsScreen({ navigation }: Props) {
  const { user, signOut, updateUser } = useAuth();

  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [editEmergency, setEditEmergency] = useState(false);
  const [emergencyInput, setEmergencyInput] = useState('');
  const [savingField, setSavingField] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getEmergencyContact().then(setEmergencyPhone).catch(() => {});
    }, []),
  );

  // Every privacy switch writes through the same path so one of them can't
  // silently diverge from the others.
  async function setFlag(field: 'share_live_location' | 'show_rides' | 'show_garage', next: boolean) {
    if (!user || savingField) return;
    setSavingField(field);
    try {
      await api.put(`/api/users/${user.id}`, { [field]: next });
      await updateUser({ [field]: next });
      // Turning live location off should remove us from other riders' maps at
      // once, not at the next heartbeat.
      if (field === 'share_live_location' && !next) goOffline();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSavingField(null);
    }
  }

  const emergencyValid = (() => {
    const digits = emergencyInput.replace(/[^\d]/g, '');
    return digits.length >= 10 && digits.length <= 15;
  })();

  async function saveEmergency() {
    if (!emergencyValid) return;
    await setEmergencyContact(emergencyInput.trim());
    setEmergencyPhone(emergencyInput.trim());
    setEditEmergency(false);
  }

  async function reallyDelete() {
    setDeleting(true);
    try {
      await deleteAccount();
      setConfirmDelete(false);
      await signOut();
    } catch (err) {
      Alert.alert('Silinemedi', errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  const version = Constants.expoConfig?.version ?? '—';

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Section title="Hesap" />
        <Card style={styles.group}>
          <Row
            icon="account-edit"
            title="Profil bilgileri"
            sub="İsim, kullanıcı adı, bio, ülke"
            onPress={() => navigation.navigate('EditProfile')}
          />
          <Row icon="email-outline" title="E-posta" sub={user?.email ?? '—'} />
        </Card>

        <Section title="Gizlilik" />
        <Card style={styles.group}>
          <ToggleRow
            icon="map-marker-radius"
            title="Haritada görün"
            sub="Açıkken yakındaki sürücüler sürüş sırasındaki konumunu haritada canlı görebilir. Kapattığında haritadan hemen kaldırılırsın."
            value={!!user?.share_live_location}
            busy={savingField === 'share_live_location'}
            onChange={(v) => setFlag('share_live_location', v)}
          />
          <ToggleRow
            icon="motorbike"
            title="Sürüşlerim profilimde görünsün"
            sub="Sadece özet gösterilir: mesafe, max hız, süre ve tarih. Rotan ve harita izin hiçbir zaman paylaşılmaz."
            value={user?.show_rides ?? true}
            busy={savingField === 'show_rides'}
            onChange={(v) => setFlag('show_rides', v)}
          />
          <ToggleRow
            icon="garage-variant"
            title="Garajım profilimde görünsün"
            sub="Motorlarının adı ve yılı gösterilir. Plaka ve belge tarihleri her zaman gizli kalır."
            value={user?.show_garage ?? true}
            busy={savingField === 'show_garage'}
            onChange={(v) => setFlag('show_garage', v)}
          />
          <Row
            icon="account-cancel-outline"
            title="Engellenen kullanıcılar"
            sub="Engellediklerini gör ve geri al"
            onPress={() => navigation.navigate('BlockedUsers')}
          />
        </Card>

        <Section title="Güvenlik" />
        <Card style={styles.group}>
          <Row
            icon="phone-alert"
            title="Acil durum kişisi"
            sub={emergencyPhone || 'Kayıtlı değil — kaza algılandığında SMS taslağı için ekle'}
            onPress={() => {
              setEmergencyInput(emergencyPhone);
              setEditEmergency(true);
            }}
          />
        </Card>

        <Section title="Uygulama" />
        <Card style={styles.group}>
          <Row
            icon="compass-outline"
            title="Uygulama turu"
            sub="Ana özellikleri ekran üzerinde adım adım tekrar gör"
            onPress={replayOnboarding}
          />
          <Row icon="information-outline" title="Sürüm" sub={version} />
        </Card>

        <View style={{ height: spacing.sm }} />
        <Button title="Çıkış Yap" variant="ghost" icon="logout" onPress={signOut} />

        {/* Required by App Store 5.1.1(v). Visually last and visually quiet —
            present and findable, but not competing with anything else. */}
        <Pressable
          style={styles.deleteLink}
          onPress={() => {
            setDeleteInput('');
            setConfirmDelete(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Hesabımı sil"
        >
          <Text style={styles.deleteLinkText}>Hesabımı sil</Text>
        </Pressable>
      </ScrollView>

      {/* Emergency contact */}
      <Modal
        visible={editEmergency}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setEditEmergency(false)}
      >
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setEditEmergency(false)}
            accessibilityRole="button"
            accessibilityLabel="Kapat"
          >
            <Pressable style={styles.sheet} onPress={() => {}} accessible={false}>
              <Text style={styles.sheetTitle}>Acil Durum Kişisi</Text>
              <Text style={styles.sub}>
                Kaza algılandığında bu numaraya konumunu içeren SMS taslağı hazırlanır. Numara yalnız bu cihazda
                saklanır — telefon değiştirirsen yeniden girmen gerekir.
              </Text>
              <TextField
                icon="phone"
                placeholder="+90 5xx xxx xx xx"
                value={emergencyInput}
                onChangeText={setEmergencyInput}
                keyboardType="phone-pad"
                autoFocus
              />
              {emergencyInput.length > 0 && !emergencyValid ? (
                <Text style={styles.error}>Geçerli bir telefon numarası gir (en az 10 hane).</Text>
              ) : null}
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveEmergency} disabled={!emergencyValid} />
              <View style={{ height: spacing.xs }} />
              <Button
                title="Test mesajı gönder"
                icon="message-check-outline"
                variant="ghost"
                disabled={!emergencyValid}
                onPress={async () => {
                  try {
                    await composeTestSMS(emergencyInput.trim());
                  } catch {
                    Alert.alert('Açılamadı', 'Mesaj uygulaması açılamadı.');
                  }
                }}
              />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Account deletion. Typing the username is the confirmation: a rider who
          can produce it has read the screen, which a "yes/no" alert can't tell. */}
      <Modal
        visible={confirmDelete}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setConfirmDelete(false)}
      >
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setConfirmDelete(false)}
            accessibilityRole="button"
            accessibilityLabel="Kapat"
          >
            <Pressable style={styles.sheet} onPress={() => {}} accessible={false}>
              <View style={styles.dangerHead}>
                <MaterialCommunityIcons name="alert-octagon" size={24} color={colors.danger} />
                <Text style={styles.dangerTitle}>Hesabını sil</Text>
              </View>
              <Text style={styles.sub}>Bu işlem geri alınamaz. Kalıcı olarak silinecekler:</Text>
              <View style={styles.bullets}>
                {[
                  'Tüm sürüşlerin ve harita izlerin',
                  'Kayıtlı rotaların ve mola noktaların',
                  'Gönderilerin, yorumların ve mesajların',
                  'Garajın, rozetlerin ve XP’n',
                  'Takip ettiklerin ve takipçilerin',
                ].map((line) => (
                  <View key={line} style={styles.bulletRow}>
                    <MaterialCommunityIcons name="circle-small" size={18} color={colors.textMuted} />
                    <Text style={styles.bulletText}>{line}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.sub}>
                Onaylamak için kullanıcı adını yaz: <Text style={styles.mono}>{user?.username}</Text>
              </Text>
              <TextField
                icon="at"
                placeholder={user?.username ?? 'kullanici_adi'}
                value={deleteInput}
                onChangeText={setDeleteInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{ height: spacing.sm }} />
              <Button
                title="Hesabımı kalıcı olarak sil"
                variant="danger"
                icon="delete-forever"
                loading={deleting}
                disabled={deleteInput.trim() !== (user?.username ?? '')}
                onPress={reallyDelete}
              />
              <View style={{ height: spacing.xs }} />
              <Button title="Vazgeç" variant="ghost" onPress={() => setConfirmDelete(false)} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function Section({ title }: { title: string }) {
  return <Text style={styles.section}>{title}</Text>;
}

function Row({
  icon,
  title,
  sub,
  onPress,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  onPress?: () => void;
}) {
  const body = (
    <View style={styles.row}>
      <MaterialCommunityIcons name={icon} size={22} color={colors.primary} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      {onPress ? <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} /> : null}
    </View>
  );
  return onPress ? (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && styles.rowPressed}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}. ${sub}` : title}
    >
      {body}
    </Pressable>
  ) : (
    <View accessibilityRole="text" accessibilityLabel={sub ? `${title}: ${sub}` : title}>
      {body}
    </View>
  );
}

function ToggleRow({
  icon,
  title,
  sub,
  value,
  busy,
  onChange,
}: {
  icon: IconName;
  title: string;
  sub: string;
  value: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <MaterialCommunityIcons name={icon} size={22} color={colors.primary} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={busy}
        trackColor={{ false: colors.surfaceAlt, true: colors.primary }}
        thumbColor="#fff"
        accessibilityLabel={title}
        accessibilityState={{ checked: value, disabled: busy }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  section: { color: colors.textMuted, fontWeight: '800', fontSize: 13, marginTop: spacing.lg, marginBottom: spacing.xs, marginLeft: spacing.xs },
  group: { gap: 0, paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, minHeight: 56 },
  rowPressed: { opacity: 0.6 },
  rowTitle: { color: colors.text, fontWeight: '700', fontSize: 15 },
  rowSub: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  deleteLink: { alignSelf: 'center', marginTop: spacing.xl, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  deleteLinkText: { color: colors.danger, fontWeight: '700', fontSize: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  sheetTitle: { color: colors.text, fontWeight: '900', fontSize: 18 },
  sub: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.danger, fontSize: 13, fontWeight: '600', marginTop: spacing.xs },
  dangerHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dangerTitle: { color: colors.danger, fontWeight: '900', fontSize: 18 },
  bullets: { gap: 2, marginVertical: spacing.xs },
  bulletRow: { flexDirection: 'row', alignItems: 'center' },
  bulletText: { color: colors.text, fontSize: 14, flex: 1 },
  mono: { color: colors.text, fontWeight: '900' },
});
