import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { darkMapStyle } from '../lib/mapStyle';
import { fmtSeconds, LeaderboardEntry, Segment } from '../lib/segments';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'SegmentDetail'>;
type Coord = { latitude: number; longitude: number };

const ISTANBUL: Region = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.1, longitudeDelta: 0.1 };

export default function SegmentDetailScreen({ route, navigation }: Props) {
  const { id, name } = route.params;
  const { user } = useAuth();
  const [seg, setSeg] = useState<Segment | null>(null);
  const [coords, setCoords] = useState<Coord[]>([]);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [deleting, setDeleting] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/segments/${id}`);
      setSeg(data);
      const pts: Coord[] = (data.points ?? []).map((p: { lat: number; lon: number }) => ({
        latitude: p.lat,
        longitude: p.lon,
      }));
      setCoords(pts);
      if (pts.length > 1) {
        setTimeout(
          () =>
            mapRef.current?.fitToCoordinates(pts, {
              edgePadding: { top: 60, right: 50, bottom: 60, left: 50 },
              animated: true,
            }),
          300,
        );
      }
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
    try {
      const { data } = await api.get(`/api/segments/${id}/leaderboard`);
      setBoard(data.entries ?? []);
    } catch {
      // ignore
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function confirmDelete() {
    Alert.alert('Segmenti sil', `"${seg?.name ?? name}" ve tüm denemeler silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            setDeleting(true);
            await api.delete(`/api/segments/${id}`);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  }

  const initialRegion: Region = coords[0]
    ? { ...coords[0], latitudeDelta: 0.05, longitudeDelta: 0.05 }
    : ISTANBUL;
  const start = coords[0];
  const end = coords[coords.length - 1];
  const isOwner = seg != null && user?.id === seg.user_id;

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} initialRegion={initialRegion} customMapStyle={darkMapStyle}>
        {coords.length > 1 && <Polyline coordinates={coords} strokeColor={colors.primary} strokeWidth={5} />}
        {start && (
          <Marker coordinate={start} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={[styles.dot, { backgroundColor: colors.success }]} />
          </Marker>
        )}
        {end && coords.length > 1 && (
          <Marker coordinate={end} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={[styles.dot, { backgroundColor: colors.danger }]} />
          </Marker>
        )}
      </MapView>

      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>
        <Card>
          <View style={styles.headRow}>
            <Text style={styles.title}>{seg?.name ?? name}</Text>
            <Text style={styles.dist}>{(seg?.distance ?? 0).toFixed(1)} km</Text>
          </View>
          {seg?.my_best_seconds ? (
            <View style={styles.prRow}>
              <MaterialCommunityIcons name="trophy" size={16} color={colors.accent} />
              <Text style={styles.prText}>Senin rekorun: {fmtSeconds(seg.my_best_seconds)}</Text>
            </View>
          ) : (
            <Text style={styles.muted}>Bu segmentten geçen bir sürüşün yok. Buradan geç, otomatik sıralanırsın.</Text>
          )}
        </Card>

        <Text style={styles.section}>Sıralama</Text>
        {board.length === 0 ? (
          <Card>
            <Text style={styles.muted}>Henüz deneme yok. İlk sıralayı sen yakala!</Text>
          </Card>
        ) : (
          board.map((e, i) => (
            <Card key={e.user_id} style={[styles.boardRow, e.user_id === user?.id && styles.boardMine]}>
              <Text style={[styles.rank, i === 0 && { color: colors.accent }]}>{i + 1}</Text>
              <View style={styles.flex}>
                <Text style={styles.boardName}>{e.name}</Text>
                <Text style={styles.boardMeta}>{Math.round(e.avg_speed)} km/s ort.</Text>
              </View>
              <Text style={styles.time}>{fmtSeconds(e.elapsed_seconds)}</Text>
            </Card>
          ))
        )}

        {isOwner && (
          <>
            <View style={{ height: spacing.md }} />
            <Button title="Segmenti Sil" variant="ghost" icon="trash-can-outline" onPress={confirmDelete} loading={deleting} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  map: { height: '40%' },
  sheet: { flex: 1 },
  sheetContent: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', flex: 1 },
  dist: { color: colors.primary, fontSize: 18, fontWeight: '900' },
  prRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm },
  prText: { color: colors.text, fontWeight: '700' },
  muted: { color: colors.textMuted, marginTop: spacing.xs },
  section: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: spacing.sm },
  boardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  boardMine: { borderColor: colors.primary, borderWidth: 1 },
  rank: { color: colors.text, fontSize: 18, fontWeight: '900', width: 26, textAlign: 'center' },
  boardName: { color: colors.text, fontWeight: '800' },
  boardMeta: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  time: { color: colors.text, fontWeight: '900', fontSize: 16, fontVariant: ['tabular-nums'] },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#fff', ...shadow.card },
});
