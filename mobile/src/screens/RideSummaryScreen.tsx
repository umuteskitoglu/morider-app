import React, { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, Card, EmptyState, TextField } from '../components/ui';
import { darkMapStyle } from '../lib/mapStyle';
import { computeRideStats } from '../lib/rideStats';
import { getLastRideSummary, setLastRideSummary } from '../lib/rideStore';
import { createRouteFromTrack, defaultRouteName } from '../lib/routeFromRide';
import { errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RideStackParams, 'RideSummary'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

/**
 * What a finished ride used to get was `Alert.alert('🏁 Sürüş kaydedildi')` —
 * one line, dismissed in a second, and every bit of the day's meaning thrown
 * away with it. This is where the ride actually lands: the shape of the route,
 * the numbers worth having, and the lean angle that has no business being on
 * screen while cornering.
 */
export default function RideSummaryScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const summary = getLastRideSummary();
  const [savingRoute, setSavingRoute] = useState(false);
  const [routeName, setRouteName] = useState('');
  const [askName, setAskName] = useState(false);
  const [savedRoute, setSavedRoute] = useState<string | null>(null);

  const stats = useMemo(() => {
    if (!summary) return null;
    return computeRideStats(
      summary.draft.samples.map((s) => ({
        lat: s.latitude,
        lon: s.longitude,
        altitude: s.altitude,
        speed: s.speed,
        ts: s.ts,
      })),
    );
  }, [summary]);

  const track = useMemo(
    () => summary?.draft.samples.map((s) => ({ latitude: s.latitude, longitude: s.longitude })) ?? [],
    [summary],
  );

  // Pushed on top of the map, so going back is exactly right: the rider lands
  // where they started, ready for the next ride.
  function done() {
    setLastRideSummary(null);
    navigation.goBack();
  }

  if (!summary || !stats) {
    return (
      <View style={styles.container}>
        <EmptyState icon="motorbike" title="Özet bulunamadı" hint="Bu sürüşün detaylarına Sürüşlerim'den ulaşabilirsin." />
        <View style={styles.footer}>
          <Button title="Kapat" variant="ghost" onPress={done} />
        </View>
      </View>
    );
  }

  const { draft, uploaded, kapisma } = summary;
  const maxLean = Math.max(draft.maxLeanRight, draft.maxLeanLeft);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}>
        <View style={styles.hero}>
          <MaterialCommunityIcons name="flag-checkered" size={36} color={colors.primary} />
          <Text style={styles.heroKm}>
            {draft.distance.toFixed(1)}
            <Text style={styles.heroUnit}> km</Text>
          </Text>
          <Text style={styles.heroSub}>{fmtDuration(summary.movingMs)} hareket halinde</Text>
        </View>

        {/* Honest about where the ride actually is. A rider who finished in a
            dead zone should not be left guessing whether it survived. */}
        {!uploaded && (
          <View style={styles.queued}>
            <MaterialCommunityIcons name="cloud-off-outline" size={18} color={colors.warning} />
            <Text style={styles.queuedText}>
              Cihazına kaydedildi. İnternet bağlantısı gelince otomatik olarak yüklenecek.
            </Text>
          </View>
        )}

        {track.length > 1 && (
          <Card style={styles.mapCard}>
            <MapView
              style={styles.map}
              customMapStyle={darkMapStyle}
              userInterfaceStyle="dark"
              pointerEvents="none"
              onLayout={() => {}}
              initialRegion={regionFor(track)}
            >
              <Polyline coordinates={track} strokeColor={colors.primary} strokeWidth={4} lineCap="round" />
            </MapView>
          </Card>
        )}

        <View style={styles.grid}>
          <Tile icon="speedometer" label="Max hız" value={`${Math.round(stats.maxSpeed)}`} unit="km/s" />
          <Tile icon="speedometer-medium" label="Ort. hız" value={`${Math.round(stats.avgSpeed)}`} unit="km/s" />
          <Tile icon="image-filter-hdr" label="Tırmanış" value={`${Math.round(stats.ascent)}`} unit="m" />
          <Tile icon="clock-outline" label="Toplam süre" value={fmtDuration(stats.durationMs)} unit="" />
          {maxLean > 0 && (
            <Tile icon="angle-acute" label="Max yatış" value={`${Math.round(maxLean)}`} unit="°" />
          )}
          <Tile icon="arrow-expand-vertical" label="En yüksek" value={`${Math.round(stats.maxAlt)}`} unit="m" />
        </View>

        {kapisma ? (
          <Card style={styles.kapisma}>
            <MaterialCommunityIcons name="trophy" size={22} color={colors.accent} />
            <Text style={styles.kapismaText}>{kapisma}</Text>
          </Card>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {/* The best routes a rider owns are the ones they already rode. Until
            now a good day could never be repeated or handed to a friend. */}
        <Button
          title={savedRoute ? `Rota kaydedildi: ${savedRoute}` : 'Rota olarak kaydet'}
          variant="ghost"
          icon={savedRoute ? 'check' : 'map-marker-path'}
          disabled={!!savedRoute || track.length < 2}
          onPress={() => {
            setRouteName(defaultRouteName(new Date(draft.startTime)));
            setAskName(true);
          }}
        />
        <View style={{ height: spacing.sm }} />
        <Button title="Tamam" icon="check" onPress={done} />
      </View>

      <Modal
        visible={askName}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setAskName(false)}
      >
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setAskName(false)}
            accessibilityRole="button"
            accessibilityLabel="Kapat"
          >
            <Pressable style={styles.sheet} onPress={() => {}} accessible={false}>
              <Text style={styles.sheetTitle}>Rota olarak kaydet</Text>
              <Text style={styles.sheetSub}>
                Bu sürüşün izi rotalarına eklenir. Daha sonra aynı yolu navigasyonla tekrar sürebilir ya da
                arkadaşlarınla paylaşabilirsin.
              </Text>
              <TextField label="Rota adı" icon="map-marker-path" value={routeName} onChangeText={setRouteName} maxLength={80} />
              <View style={{ height: spacing.sm }} />
              <Button
                title="Kaydet"
                icon="content-save"
                loading={savingRoute}
                disabled={!routeName.trim()}
                onPress={async () => {
                  setSavingRoute(true);
                  try {
                    const created = await createRouteFromTrack(routeName, track);
                    setSavedRoute(created.name);
                    setAskName(false);
                    Alert.alert('Rota kaydedildi', `${created.name} • ${created.distance.toFixed(1)} km`);
                  } catch (err) {
                    Alert.alert('Kaydedilemedi', errorMessage(err));
                  } finally {
                    setSavingRoute(false);
                  }
                }}
              />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// Fit the whole track with a little breathing room around it.
function regionFor(track: { latitude: number; longitude: number }[]) {
  let minLat = track[0].latitude, maxLat = track[0].latitude;
  let minLon = track[0].longitude, maxLon = track[0].longitude;
  for (const p of track) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLon) minLon = p.longitude;
    if (p.longitude > maxLon) maxLon = p.longitude;
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.4),
    longitudeDelta: Math.max(0.01, (maxLon - minLon) * 1.4),
  };
}

function Tile({ icon, label, value, unit }: { icon: IconName; label: string; value: string; unit: string }) {
  return (
    <View style={styles.tile} accessibilityRole="text" accessibilityLabel={`${label}: ${value} ${unit}`}>
      <MaterialCommunityIcons name={icon} size={20} color={colors.primary} />
      <Text style={styles.tileValue}>
        {value}
        {unit ? <Text style={styles.tileUnit}> {unit}</Text> : null}
      </Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
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
  sheetSub: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: spacing.sm },
  content: { padding: spacing.md, gap: spacing.md },
  hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg },
  heroKm: { color: colors.text, fontSize: 56, fontWeight: '900', fontVariant: ['tabular-nums'] },
  heroUnit: { color: colors.textMuted, fontSize: 22, fontWeight: '800' },
  heroSub: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
  queued: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,176,32,0.12)',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  queuedText: { color: colors.text, fontSize: 13, lineHeight: 18, flex: 1 },
  mapCard: { padding: 0, overflow: 'hidden' },
  map: { height: 220, width: '100%' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    width: '48%',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
  },
  tileValue: { color: colors.text, fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'] },
  tileUnit: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  tileLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  kapisma: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  kapismaText: { color: colors.text, fontSize: 14, lineHeight: 20, flex: 1 },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
