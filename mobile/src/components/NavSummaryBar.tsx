import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, shadow, spacing } from '../theme';

const ETA_GREEN = '#34C759';

/**
 * Google-Maps-style bottom sheet while navigating: a big remaining-time figure,
 * the remaining distance and the arrival clock, plus a round exit button. The
 * arrival clock ticks every second so it stays current between GPS fixes.
 */
export function NavSummaryBar({
  remainingKm,
  remainingMin,
  onStop,
  bottomInset = 0,
}: {
  remainingKm: number;
  remainingMin: number;
  onStop: () => void;
  bottomInset?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const eta = new Date(now + remainingMin * 60_000);
  const etaText = `${eta.getHours().toString().padStart(2, '0')}:${eta.getMinutes().toString().padStart(2, '0')}`;
  const distText = remainingKm >= 1 ? `${remainingKm.toFixed(1).replace('.', ',')} km` : `${Math.round(remainingKm * 1000)} m`;
  const minText = remainingMin >= 1 ? `${Math.round(remainingMin)} dk` : '<1 dk';

  return (
    <View style={[styles.sheet, { paddingBottom: bottomInset + spacing.md }]}>
      <View style={styles.handle} />
      <View style={styles.row}>
        <View style={styles.info}>
          <Text style={styles.min}>{minText}</Text>
          <Text style={styles.sub}>
            {distText} • varış {etaText}
          </Text>
        </View>
        <Pressable style={styles.stopBtn} onPress={onStop} hitSlop={8}>
          <MaterialCommunityIcons name="close" size={26} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Current-speed indicator (Google's bottom-left speed circle): a white pill with
 * the speed and unit. `limit`, when known, could later drive a red ring.
 */
export function SpeedPill({ speed, bottomInset = 0 }: { speed: number; bottomInset?: number }) {
  return (
    <View style={[styles.speedPill, { bottom: bottomInset + 150 }]}>
      <Text style={styles.speedValue}>{Math.max(0, Math.round(speed))}</Text>
      <Text style={styles.speedUnit}>km/s</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#1B1B1F',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    ...shadow.card,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#3A3A40', marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  info: { flex: 1 },
  min: { color: ETA_GREEN, fontSize: 26, fontWeight: '900', letterSpacing: -0.5 },
  sub: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 2 },
  stopBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  speedPill: {
    position: 'absolute',
    left: spacing.md,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  speedValue: { color: '#1a1a1a', fontSize: 22, fontWeight: '900', lineHeight: 24 },
  speedUnit: { color: '#666', fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
});
