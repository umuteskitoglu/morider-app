import React, { useState } from 'react';
import {
  Alert,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from 'react-native';
import MapView, { MapPressEvent, Marker, Polyline } from 'react-native-maps';
import Slider from '@react-native-community/slider';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type PlanInfo = { distance: number; duration: number; steps: number; curviness: number };
type Props = NativeStackScreenProps<ProfileStackParams, 'RouteCreate'>;

// Old Android needs an explicit opt-in for LayoutAnimation.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Human label for the backend's deg/km curviness score.
function curvinessText(score: number): string {
  if (score < 30) return 'düz';
  if (score < 100) return 'kıvrımlı';
  return 'çok virajlı';
}

export default function RouteCreateScreen({ navigation }: Props) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState<Coord[]>([]);
  const [snapped, setSnapped] = useState<Coord[]>([]);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'friends' | 'public'>('private');
  const [curviness, setCurviness] = useState(0.5);
  // Detail form (name/curviness/visibility) collapses so the map stays visible
  // while placing waypoints. It springs open automatically when saving.
  const [expanded, setExpanded] = useState(false);

  function toggleExpanded(next?: boolean) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => next ?? !prev);
  }

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
        curviness,
      });
      setSnapped(
        (data.points ?? []).map((p: { lat: number; lon: number }) => ({
          latitude: p.lat,
          longitude: p.lon,
        })),
      );
      setPlan({
        distance: data.distance,
        duration: data.duration,
        steps: (data.steps ?? []).length,
        curviness: data.curviness ?? 0,
      });
    } catch (err) {
      Alert.alert('Hesaplanamadı', errorMessage(err));
    } finally {
      setPlanning(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      toggleExpanded(true);
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
        curviness,
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
        <Pressable style={styles.header} onPress={() => toggleExpanded()} hitSlop={8}>
          <View style={styles.headerText}>
            {plan ? (
              <Text style={styles.stats} numberOfLines={1}>
                ≈ {plan.distance.toFixed(2)} km • {plan.duration.toFixed(0)} dk • {plan.steps} dönüş •{' '}
                {curvinessText(plan.curviness)}
              </Text>
            ) : (
              <Text style={styles.hint} numberOfLines={1}>
                Haritaya dokunarak yol noktaları ekle.
              </Text>
            )}
            <Text style={styles.subHint} numberOfLines={1}>
              {name.trim() ? name.trim() : 'Rota adı yok'} • {expanded ? 'Ayarları gizle' : 'Ayarlar'}
            </Text>
          </View>
          <MaterialCommunityIcons
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={24}
            color={colors.textMuted}
          />
        </Pressable>

        {expanded && (
          <View style={styles.form}>
            <TextField label="Rota adı" value={name} onChangeText={setName} placeholder="Sahil turu" />
            <View style={styles.curvyRow}>
              <MaterialCommunityIcons name="arrow-expand-horizontal" size={16} color={colors.textMuted} />
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={1}
                value={curviness}
                onSlidingComplete={setCurviness}
                minimumTrackTintColor={colors.primary}
                maximumTrackTintColor={colors.border}
                thumbTintColor={colors.primary}
              />
              <MaterialCommunityIcons name="sine-wave" size={16} color={colors.primary} />
            </View>
            <Text style={styles.curvyHint}>
              Virajlılık tercihi (2 nokta arasında alternatif rotalardan seçer)
            </Text>
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
          </View>
        )}

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
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  headerText: { flex: 1 },
  subHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  form: { marginBottom: spacing.xs },
  hint: { color: colors.text, fontWeight: '600' },
  curvyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm },
  slider: { flex: 1, height: 32 },
  curvyHint: { color: colors.textMuted, fontSize: 11, marginBottom: spacing.sm },
  stats: { color: colors.primary, fontWeight: '700' },
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
