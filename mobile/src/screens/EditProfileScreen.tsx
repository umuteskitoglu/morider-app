import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { useAuth } from '../store/auth';
import { api, apiBaseURL, errorMessage } from '../api/client';
import { colors, gradients, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'EditProfile'>;

export default function EditProfileScreen({ navigation }: Props) {
  const { user, updateUser } = useAuth();

  const [name, setName] = useState(user?.name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [country, setCountry] = useState(user?.country ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url ?? '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);

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
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.7 };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;

    try {
      setUploadingAvatar(true);
      const asset = res.assets[0];
      const type = asset.mimeType ?? 'image/jpeg';
      const ext = type.split('/')[1] ?? 'jpg';
      const form = new FormData();
      form.append('photo', { uri: asset.uri, name: `avatar.${ext}`, type } as any);
      const { data } = await api.post('/api/feed/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      // Persist immediately so the avatar sticks even if the rest isn't saved.
      await api.put(`/api/users/${user!.id}`, { avatar_url: data.url });
      await updateUser({ avatar_url: data.url });
      setAvatarUrl(data.url);
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function save() {
    if (!user) return;
    if (!name.trim()) {
      Alert.alert('Eksik bilgi', 'İsim boş olamaz.');
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username.trim())) {
      Alert.alert('Geçersiz kullanıcı adı', '3-20 karakter: harf, rakam veya _');
      return;
    }
    try {
      setSaving(true);
      // Send only changed fields; bio/country can be cleared (empty allowed).
      const body: Record<string, unknown> = {};
      if (name.trim() !== user.name) body.name = name.trim();
      if (username.trim() !== user.username) body.username = username.trim();
      if (bio !== (user.bio ?? '')) body.bio = bio;
      if (country !== (user.country ?? '')) body.country = country;

      if (Object.keys(body).length > 0) {
        const { data } = await api.put(`/api/users/${user.id}`, body);
        await updateUser({ name: data.name, username: data.username, bio: data.bio, country: data.country });
      }
      navigation.goBack();
    } catch (err) {
      const status = (err as any)?.response?.status;
      Alert.alert('Kaydedilemedi', status === 409 ? 'Bu kullanıcı adı alınmış' : errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.avatarWrap}>
          <Pressable onPress={changeAvatar} disabled={uploadingAvatar}>
            {avatarUrl ? (
              <Image source={{ uri: apiBaseURL() + avatarUrl }} style={styles.avatar} />
            ) : (
              <LinearGradient colors={gradients.primary} style={styles.avatar}>
                <Text style={styles.avatarText}>{name.charAt(0).toUpperCase() || 'M'}</Text>
              </LinearGradient>
            )}
            <View style={styles.avatarBadge}>
              {uploadingAvatar ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialCommunityIcons name="camera" size={15} color="#fff" />
              )}
            </View>
          </Pressable>
          <Pressable onPress={changeAvatar} disabled={uploadingAvatar} hitSlop={8}>
            <Text style={styles.changePhoto}>Fotoğrafı Değiştir</Text>
          </Pressable>
        </View>

        <Card style={styles.form}>
          <TextField label="İsim" icon="account" value={name} onChangeText={setName} placeholder="Adın Soyadın" maxLength={60} />
          <TextField
            label="Kullanıcı adı"
            icon="at"
            value={username}
            onChangeText={setUsername}
            placeholder="kullanici_adi"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
          />
          <TextField
            label="Hakkında (bio)"
            icon="text"
            value={bio}
            onChangeText={setBio}
            placeholder="Kendinden bahset…"
            multiline
            maxLength={150}
          />
          <Text style={styles.counter}>{bio.length}/150</Text>
          <TextField label="Ülke" icon="map-marker" value={country} onChangeText={setCountry} placeholder="Türkiye" maxLength={56} />
        </Card>

        <Button title="Kaydet" icon="content-save" onPress={save} loading={saving} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  avatarWrap: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  avatar: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', ...shadow.glow },
  avatarText: { color: '#fff', fontSize: 38, fontWeight: '900' },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePhoto: { color: colors.primary, fontWeight: '800', fontSize: 14 },
  form: { gap: spacing.xs },
  counter: { color: colors.textMuted, fontSize: 11, alignSelf: 'flex-end', marginTop: -spacing.sm, marginBottom: spacing.xs },
});
