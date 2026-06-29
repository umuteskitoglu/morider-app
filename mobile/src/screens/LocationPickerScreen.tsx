import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { MapPressEvent, Marker, Region } from 'react-native-maps';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Location from 'expo-location';

import { FeedStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { PlaceSearch } from '../components/PlaceSearch';
import { Place } from '../lib/geocode';
import { colors, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type Props = NativeStackScreenProps<FeedStackParams, 'LocationPicker'>;

const ISTANBUL: Region = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.2, longitudeDelta: 0.2 };

export default function LocationPickerScreen({ navigation }: Props) {
  const [marker, setMarker] = useState<Coord | null>(null);
  const [pickedName, setPickedName] = useState('');
  const [near, setNear] = useState<{ lat: number; lon: number } | undefined>();
  const [busy, setBusy] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  // Center on the rider's current location when available.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setNear({ lat: loc.coords.latitude, lon: loc.coords.longitude });
        mapRef.current?.animateToRegion(
          { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 },
          600,
        );
      } catch {
        // keep default region
      }
    })();
  }, []);

  function onPress(e: MapPressEvent) {
    setMarker(e.nativeEvent.coordinate);
    setPickedName(''); // tapped point: reverse-geocode on confirm
  }

  function onPickPlace(place: Place) {
    const coord = { latitude: place.lat, longitude: place.lon };
    setMarker(coord);
    setPickedName(place.name);
    mapRef.current?.animateToRegion({ ...coord, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 600);
  }

  async function confirm() {
    if (!marker) return;
    setBusy(true);
    let name = pickedName;
    if (!name) {
      try {
        const [p] = await Location.reverseGeocodeAsync({ latitude: marker.latitude, longitude: marker.longitude });
        if (p) name = [p.city ?? p.subregion, p.region].filter(Boolean).join(', ') || p.name || '';
      } catch {
        // name stays empty; coords are still attached
      }
    }
    navigation.navigate({
      name: 'CreatePost',
      params: { pickedLat: marker.latitude, pickedLon: marker.longitude, pickedName: name },
      merge: true,
    });
  }

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={ISTANBUL} onPress={onPress}>
        {marker && <Marker coordinate={marker} />}
      </MapView>

      <PlaceSearch onPick={onPickPlace} near={near} style={styles.search} />

      <Card style={styles.panel}>
        <Text style={styles.hint}>
          {marker ? 'Konum seçildi. Onaylamak için dokun.' : 'Haritaya dokunarak bir konum seç.'}
        </Text>
        <Button title="Bu Konumu Kullan" icon="map-marker-check" onPress={confirm} loading={busy} disabled={!marker} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  search: { position: 'absolute', top: spacing.md, left: spacing.md, right: spacing.md },
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg },
  hint: { color: colors.textMuted, marginBottom: spacing.sm, textAlign: 'center' },
});
