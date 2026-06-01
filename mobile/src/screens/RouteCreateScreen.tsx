import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { MapPressEvent, Marker, Polyline } from 'react-native-maps';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type PlanInfo = { distance: number; duration: number; steps: number };
type Props = NativeStackScreenProps<ProfileStackParams, 'RouteCreate'>;

export default function RouteCreateScreen({ navigation }: Props) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState<Coord[]>([]);
  const [snapped, setSnapped] = useState<Coord[]>([]);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'friends' | 'public'>('private');

  // Any change to the waypoints invalidates a previously computed preview.
  function setWaypoints(next: Coord[]) {
    setPoints(next);
    setSnapped([]);
    setPlan(null);
  }

  function onMapPress(e: MapPressEvent) {
    setWaypoints([...points, e.nativeEvent.coordinate]);
  }

  function undo() {
    setWaypoints(points.slice(0, -1));
  }

  async function computeRoute() {
    if (points.length < 2) {
      Alert.alert('Yetersiz nokta', 'Hesaplamak için en az 2 nokta seç.');
      return;
    }
    try {
      setPlanning(true);
      const { data } = await api.post('/api/routes/plan', {
        waypoints: points.map((p) => ({ lat: p.latitude, lon: p.longitude })),
      });
      setSnapped(
        (data.points ?? []).map((p: { lat: number; lon: number }) => ({
          latitude: p.lat,
          longitude: p.lon,
        })),
      );
      setPlan({ distance: data.distance, duration: data.duration, steps: (data.steps ?? []).length });
    } catch (err) {
      Alert.alert('Hesaplanamadı', errorMessage(err));
    } finally {
      setPlanning(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      Alert.alert('İsim gerekli', 'Rotaya bir isim ver.');
      return;
    }
    if (points.length < 2) {
      Alert.alert('Yetersiz nokta', 'Rota için haritada en az 2 nokta seç.');
      return;
    }
    try {
      setSaving(true);
      const { data } = await api.post('/api/routes', {
        name: name.trim(),
        description: '',
        points: points.map((p) => ({ lat: p.latitude, lon: p.longitude })),
        snap: true,
        visibility,
      });
      Alert.alert('Rota kaydedildi', `${data.name} • ${data.distance.toFixed(2)} km`);
      setName('');
      setWaypoints([]);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const line = snapped.length > 1 ? snapped : points;

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={{ latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.1, longitudeDelta: 0.1 }}
        onPress={onMapPress}
      >
        {points.map((p, i) => (
          <Marker key={i} coordinate={p} title={`${i + 1}`} />
        ))}
        {line.length > 1 && <Polyline coordinates={line} strokeColor={colors.primary} strokeWidth={4} />}
      </MapView>

      <Card style={styles.panel}>
        <Text style={styles.hint}>Haritaya dokunarak yol noktaları ekle.</Text>
        {plan && (
          <Text style={styles.stats}>
            ≈ {plan.distance.toFixed(2)} km • {plan.duration.toFixed(0)} dk • {plan.steps} dönüş
          </Text>
        )}
        <TextField label="Rota adı" value={name} onChangeText={setName} placeholder="Sahil turu" />
        <View style={styles.segment}>
          {([
            { v: 'private', icon: 'lock', label: 'Gizli' },
            { v: 'friends', icon: 'account-group', label: 'Arkadaşlar' },
            { v: 'public', icon: 'earth', label: 'Herkese' },
          ] as const).map((opt) => {
            const active = visibility === opt.v;
            return (
              <Pressable
                key={opt.v}
                style={[styles.segmentBtn, active && styles.segmentActive]}
                onPress={() => setVisibility(opt.v)}
              >
                <MaterialCommunityIcons name={opt.icon} size={15} color={active ? colors.text : colors.textMuted} />
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Button title="Geri al" variant="ghost" icon="undo-variant" onPress={undo} />
          </View>
          <View style={{ width: spacing.sm }} />
          <View style={styles.flex}>
            <Button title="Hesapla" variant="ghost" icon="map-search-outline" onPress={computeRoute} loading={planning} />
          </View>
        </View>
        <View style={{ height: spacing.sm }} />
        <Button title={`Kaydet (${points.length})`} icon="content-save" onPress={save} loading={saving} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg },
  hint: { color: colors.textMuted, marginBottom: spacing.sm },
  stats: { color: colors.primary, fontWeight: '700', marginBottom: spacing.sm },
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.bgAlt,
    borderRadius: radius.md,
    padding: 3,
    marginBottom: spacing.md,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  segmentActive: { backgroundColor: colors.surfaceAlt },
  segmentText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  segmentTextActive: { color: colors.text },
});
