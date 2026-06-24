import React, { useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

import { FeedStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Asset = { uri: string; mimeType?: string };
type Props = NativeStackScreenProps<FeedStackParams, 'CreatePost'>;
type Coords = { lat: number; lon: number };

export default function CreatePostScreen({ navigation, route }: Props) {
  const [photos, setPhotos] = useState<Asset[]>([]);
  const [caption, setCaption] = useState('');
  const [locationName, setLocationName] = useState('');
  const [coords, setCoords] = useState<Coords | null>(null);
  const [saving, setSaving] = useState(false);

  // Apply a location chosen on the map picker (returned via merged params).
  const picked = route.params;
  useEffect(() => {
    if (picked?.pickedLat != null && picked?.pickedLon != null) {
      setCoords({ lat: picked.pickedLat, lon: picked.pickedLon });
      if (picked.pickedName) setLocationName(picked.pickedName);
    }
  }, [picked?.pickedLat, picked?.pickedLon, picked?.pickedName]);

  async function pickPhotos() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.7,
    });
    if (!res.canceled) {
      setPhotos(res.assets.map((a) => ({ uri: a.uri, mimeType: a.mimeType })));
    }
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  async function attachLocation() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('İzin gerekli', 'Konum eklemek için izin vermelisin.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ lat: loc.coords.latitude, lon: loc.coords.longitude });
      // Best-effort reverse geocode to prefill a friendly place name.
      try {
        const [place] = await Location.reverseGeocodeAsync({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });
        if (place && !locationName) {
          setLocationName([place.city, place.region].filter(Boolean).join(', '));
        }
      } catch {
        // ignore
      }
    } catch (err) {
      Alert.alert('Konum alınamadı', errorMessage(err));
    }
  }

  async function submit() {
    if (photos.length === 0) {
      Alert.alert('Fotoğraf gerekli', 'En az bir fotoğraf seç.');
      return;
    }
    try {
      setSaving(true);
      const form = new FormData();
      photos.forEach((a, i) => {
        const type = a.mimeType ?? 'image/jpeg';
        const ext = type.includes('png') ? 'png' : 'jpg';
        // React Native FormData file shape.
        form.append('photos', { uri: a.uri, name: `photo${i}.${ext}`, type } as any);
      });
      if (caption.trim()) form.append('caption', caption.trim());
      if (locationName.trim()) form.append('location_name', locationName.trim());
      if (coords) {
        form.append('lat', String(coords.lat));
        form.append('lon', String(coords.lon));
      }
      await api.post('/api/posts', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      navigation.goBack();
    } catch (err) {
      Alert.alert('Paylaşılamadı', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {photos.length === 0 ? (
        <Pressable style={styles.picker} onPress={pickPhotos}>
          <MaterialCommunityIcons name="image-plus" size={42} color={colors.primary} />
          <Text style={styles.pickerText}>Fotoğraf seç (en fazla 10)</Text>
        </Pressable>
      ) : (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
            {photos.map((p, i) => (
              <View key={i} style={styles.thumbWrap}>
                <Image source={{ uri: p.uri }} style={styles.thumb} />
                <Pressable style={styles.removeBtn} onPress={() => removePhoto(i)} hitSlop={8}>
                  <MaterialCommunityIcons name="close" size={16} color="#fff" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Pressable onPress={pickPhotos} style={styles.changeRow}>
            <MaterialCommunityIcons name="image-edit" size={16} color={colors.primary} />
            <Text style={styles.changeText}>Fotoğrafları değiştir ({photos.length})</Text>
          </Pressable>
        </View>
      )}

      <Card style={styles.card}>
        <TextField
          label="Açıklama"
          value={caption}
          onChangeText={setCaption}
          placeholder="Bu sürüş hakkında bir şeyler yaz..."
          multiline
          style={styles.captionInput}
        />
        <TextField
          label="Konum (opsiyonel)"
          icon="map-marker-outline"
          value={locationName}
          onChangeText={setLocationName}
          placeholder="örn. Şile sahili"
        />
        <View style={styles.locRow}>
          <View style={styles.flex}>
            <Button title="Mevcut konum" variant="ghost" icon="crosshairs-gps" onPress={attachLocation} />
          </View>
          <View style={{ width: spacing.sm }} />
          <View style={styles.flex}>
            <Button title="Haritadan seç" variant="ghost" icon="map-search" onPress={() => navigation.navigate('LocationPicker')} />
          </View>
        </View>
        {coords ? <Text style={styles.locOk}>📍 Konum eklendi{locationName ? `: ${locationName}` : ''}</Text> : null}
      </Card>

      <Button title="Paylaş" icon="send" onPress={submit} loading={saving} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  picker: {
    height: 180,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  pickerText: { color: colors.textMuted, fontWeight: '700' },
  thumbs: { gap: spacing.sm },
  thumbWrap: { position: 'relative' },
  thumb: { width: 120, height: 120, borderRadius: radius.md },
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm },
  changeText: { color: colors.primary, fontWeight: '700' },
  card: { gap: spacing.xs },
  captionInput: { minHeight: 80, textAlignVertical: 'top' },
  locRow: { flexDirection: 'row' },
  flex: { flex: 1 },
  locOk: { color: colors.success, fontWeight: '700', marginTop: spacing.sm },
});
