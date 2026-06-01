import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { MapPressEvent, Marker, Region } from 'react-native-maps';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Location from 'expo-location';

import { EventsStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { eventDraft } from '../lib/eventDraft';
import { colors, spacing } from '../theme';

type Coord = { latitude: number; longitude: number };
type Props = NativeStackScreenProps<EventsStackParams, 'EventLocationPicker'>;

const ISTANBUL: Region = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.2, longitudeDelta: 0.2 };

export default function EventLocationPickerScreen({ navigation, route }: Props) {
  const target = route.params.target;
  const [marker, setMarker] = useState<Coord | null>(null);
  const [busy, setBusy] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: target === 'start' ? 'Başlangıç Konumu' : 'Bitiş Konumu' });
  }, [navigation, target]);

  // Center on the rider's current location when available.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
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
  }

  async function confirm() {
    if (!marker) return;
    setBusy(true);
    let name = '';
    try {
      const [p] = await Location.reverseGeocodeAsync({ latitude: marker.latitude, longitude: marker.longitude });
      if (p) name = [p.city ?? p.subregion, p.region].filter(Boolean).join(', ') || p.name || '';
    } catch {
      // name stays empty; coords are still attached
    }
    const point = { lat: marker.latitude, lon: marker.longitude, name };
    // Write to the draft store (not nav params) so the other already-picked
    // point is preserved, then return to EventCreate which re-syncs on focus.
    if (target === 'start') eventDraft.setStart(point);
    else eventDraft.setEnd(point);
    navigation.goBack();
  }

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={ISTANBUL} onPress={onPress}>
        {marker && <Marker coordinate={marker} pinColor={target === 'start' ? colors.success : colors.danger} />}
      </MapView>

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
  panel: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg },
  hint: { color: colors.textMuted, marginBottom: spacing.sm, textAlign: 'center' },
});
