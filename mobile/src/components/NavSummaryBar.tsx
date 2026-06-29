import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, shadow, spacing } from '../theme';

/**
 * Google-Maps-style bottom summary while navigating: estimated arrival time,
 * remaining duration and remaining distance, plus the "end ride" button. The
 * arrival clock ticks every second so it stays current even between GPS fixes.
 */
export function NavSummaryBar({
  remainingKm,
  remainingMin,
  onStop,
}: {
  remainingKm: number;
  remainingMin: number;
  onStop: () => void;
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
    <View style={styles.bar}>
      <View style={styles.info}>
        <Text style={styles.eta}>{etaText}</Text>
        <Text style={styles.sub}>
          {minText} • {distText}
        </Text>
      </View>
      <Pressable style={styles.stopBtn} onPress={onStop} hitSlop={8}>
        <MaterialCommunityIcons name="stop-circle" size={20} color="#fff" />
        <Text style={styles.stopText}>Bitir</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(18,24,38,0.96)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...shadow.card,
  },
  info: { flex: 1 },
  eta: { color: colors.text, fontSize: 22, fontWeight: '900' },
  sub: { color: colors.textMuted, fontSize: 14, fontWeight: '700', marginTop: 2 },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.danger,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  stopText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
