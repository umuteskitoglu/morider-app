import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';

import { colors, spacing } from '../theme';

// Fixed viewBox stretched to the container (preserveAspectRatio="none"), same
// approach as ElevationChart so no layout measuring is needed.
const VW = 100;
const VH = 32;

// Speed-over-distance line chart. `series` is {dist km, speed km/h}.
export function SpeedChart({ series }: { series: { dist: number; speed: number }[] }) {
  if (series.length < 2) return null;
  const span = series[series.length - 1].dist || 1;
  const max = Math.max(...series.map((p) => p.speed), 10);
  const coords = series.map((p) => {
    const x = (p.dist / span) * VW;
    const y = VH - (p.speed / max) * (VH - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${coords.join(' L')}`;
  const area = `${line} L${VW},${VH} L0,${VH} Z`;
  return (
    <View style={styles.wrap}>
      <View style={styles.stats}>
        <MaterialCommunityIcons name="speedometer" size={14} color={colors.primary} />
        <Text style={styles.statText}>Hız</Text>
        <Text style={styles.statMuted}>en yüksek {Math.round(max)} km/s</Text>
      </View>
      <Svg style={styles.chart} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none">
        <Path d={area} fill={colors.primary} opacity={0.18} />
        <Path d={line} stroke={colors.primary} strokeWidth={0.8} fill="none" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  stats: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { color: colors.text, fontSize: 12, fontWeight: '700', marginRight: spacing.sm },
  statMuted: { color: colors.textMuted, fontSize: 12, marginLeft: 'auto' },
  chart: { width: '100%', height: 56, marginTop: spacing.xs },
});
