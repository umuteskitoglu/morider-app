import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius } from '../theme';

/** A thin horizontal progress bar. `fraction` is clamped to [0,1]. */
export function ProgressBar({ fraction, color = colors.primary }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },
});
