import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { AppTabParams, ProfileStackParams } from '../navigation/RootNavigator';
import { useAuth } from '../store/auth';
import { Button, Card, Stars } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type Props = NativeStackScreenProps<ProfileStackParams, 'RouteDetail'>;

const ISTANBUL = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.1, longitudeDelta: 0.1 };

const VISIBILITY: Record<string, { icon: any; label: string }> = {
  private: { icon: 'lock', label: 'Gizli' },
  public: { icon: 'earth', label: 'Herkese Açık' },
  friends: { icon: 'account-group', label: 'Arkadaşlar' },
};

export default function RouteDetailScreen({ route, navigation }: Props) {
  const { id, name } = route.params;
  const { user } = useAuth();
  const [coords, setCoords] = useState<Coord[]>([]);
  const [distance, setDistance] = useState(0);
  const [ownerName, setOwnerName] = useState('');
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [visibility, setVisibility] = useState('private');
  const [avgRating, setAvgRating] = useState(0);
  const [ratingCount, setRatingCount] = useState(0);
  const [myRating, setMyRating] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [startingGroup, setStartingGroup] = useState(false);
  const [exporting, setExporting] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  const isOwner = user?.id === ownerId;

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/routes/${id}`);
      const pts: Coord[] = (data.points ?? []).map((p: { lat: number; lon: number }) => ({
        latitude: p.lat,
        longitude: p.lon,
      }));
      setCoords(pts);
      setDistance(data.distance ?? 0);
      setOwnerName(data.owner_name ?? '');
      setOwnerId(data.user_id ?? null);
      setVisibility(data.visibility ?? 'private');
      setAvgRating(data.avg_rating ?? 0);
      setRatingCount(data.rating_count ?? 0);
      setMyRating(data.my_rating ?? 0);
      if (pts.length > 1) {
        setTimeout(
          () =>
            mapRef.current?.fitToCoordinates(pts, {
              edgePadding: { top: 80, right: 60, bottom: 220, left: 60 },
              animated: true,
            }),
          300,
        );
      }
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function rideThisRoute() {
    navigation
      .getParent<BottomTabNavigationProp<AppTabParams>>()
      ?.navigate('Ride', { screen: 'RideMain', params: { followRouteId: id } });
  }

  async function startGroupRide() {
    try {
      setStartingGroup(true);
      const { data } = await api.post('/api/sessions', { route_id: id });
      navigation
        .getParent<BottomTabNavigationProp<AppTabParams>>()
        ?.navigate('Ride', { screen: 'GroupRide', params: { code: data.code } });
    } catch (err) {
      Alert.alert('Başlatılamadı', errorMessage(err));
    } finally {
      setStartingGroup(false);
    }
  }

  async function exportGPX() {
    try {
      setExporting(true);
      const { data } = await api.get(`/api/routes/${id}/gpx`, {
        responseType: 'text',
        transformResponse: (d) => d,
      });
      const safeName = name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'rota';
      const uri = `${FileSystem.cacheDirectory}${safeName}.gpx`;
      await FileSystem.writeAsStringAsync(uri, String(data));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/gpx+xml', dialogTitle: 'GPX dosyasını paylaş' });
      } else {
        Alert.alert('GPX hazır', `Dosya kaydedildi: ${uri}`);
      }
    } catch (err) {
      Alert.alert('Dışa aktarılamadı', errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function rate(score: number) {
    setMyRating(score); // optimistic
    try {
      const { data } = await api.post(`/api/routes/${id}/rate`, { score });
      setAvgRating(data.avg_rating ?? 0);
      setRatingCount(data.rating_count ?? 0);
      setMyRating(data.my_rating ?? score);
    } catch (err) {
      Alert.alert('Puanlanamadı', errorMessage(err));
    }
  }

  function confirmDelete() {
    Alert.alert('Rotayı sil', `"${name}" silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            setDeleting(true);
            await api.delete(`/api/routes/${id}`);
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

  const initialRegion = coords[0] ? { ...coords[0], latitudeDelta: 0.1, longitudeDelta: 0.1 } : ISTANBUL;
  const vis = VISIBILITY[visibility] ?? VISIBILITY.private;

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={initialRegion}>
        {coords.length > 1 && <Polyline coordinates={coords} strokeColor={colors.primary} strokeWidth={5} />}
      </MapView>

      <Card style={styles.panel}>
        <View style={styles.headRow}>
          <Text style={styles.distance}>{distance.toFixed(2)} km</Text>
          <View style={styles.visBadge}>
            <MaterialCommunityIcons name={vis.icon} size={13} color={colors.textMuted} />
            <Text style={styles.visText}>{vis.label}</Text>
          </View>
        </View>
        <View style={styles.metaRow}>
          <MaterialCommunityIcons name="account-circle-outline" size={15} color={colors.textMuted} />
          <Text style={styles.muted}>{isOwner ? 'Senin rotan' : ownerName}</Text>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.muted}>{coords.length} nokta</Text>
        </View>

        <View style={styles.ratingRow}>
          <Stars value={avgRating} count={ratingCount} />
          {avgRating > 0 ? <Text style={styles.avgText}>{avgRating.toFixed(1)}</Text> : <Text style={styles.muted}>Henüz puan yok</Text>}
        </View>
        {visibility === 'public' && (
          <View style={styles.myRateRow}>
            <Text style={styles.muted}>Senin puanın:</Text>
            <Stars value={myRating} size={22} onRate={rate} />
          </View>
        )}

        <View style={{ height: spacing.md }} />
        <Button title="Bu Rotada Sür" icon="motorbike" onPress={rideThisRoute} />
        <View style={{ height: spacing.sm }} />
        <Button title="Grup Sürüşü Başlat" variant="ghost" icon="account-group" onPress={startGroupRide} loading={startingGroup} />
        <View style={{ height: spacing.sm }} />
        <Button title="GPX Dışa Aktar" variant="ghost" icon="download-outline" onPress={exportGPX} loading={exporting} />
        {isOwner ? (
          <>
            <View style={{ height: spacing.sm }} />
            <Button title="Rotayı Sil" variant="ghost" icon="trash-can-outline" onPress={confirmDelete} loading={deleting} />
          </>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  distance: { color: colors.primary, fontSize: 26, fontWeight: '900' },
  visBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
  },
  visText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  muted: { color: colors.textMuted },
  dot: { color: colors.textMuted },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  avgText: { color: colors.text, fontWeight: '800' },
  myRateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
});
