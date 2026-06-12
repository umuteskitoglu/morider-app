import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';

import { colors, spacing } from '../theme';

// Matches the backend response of GET /api/routes/:id/elevation.
export type ElevationProfile = {
  points: { dist: number; ele: number }[]; // cumulative km, meters
  gain: number;
  loss: number;
  min: number;
  max: number;
};

// Fixed viewBox; preserveAspectRatio="none" stretches it to the container so
// no layout measuring is needed.
const VW = 100;
const VH = 32;

function buildPaths(profile: ElevationProfile): { line: string; area: string } {
  const pts = profile.points;
  const span = pts[pts.length - 1].dist || 1;
  // Pad the vertical range so a flat route doesn't draw on the very edge.
  const range = Math.max(profile.max - profile.min, 10);
  const coords = pts.map((p) => {
    const x = (p.dist / span) * VW;
    const y = VH - ((p.ele - profile.min) / range) * (VH - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${coords.join(' L')}`;
  const area = `${line} L${VW},${VH} L0,${VH} Z`;
  return { line, area };
}

/** Compact elevation profile: stats row + stretched area chart. */
export function ElevationChart({ profile }: { profile: ElevationProfile }) {
  if (profile.points.length < 2) return null;
  const { line, area } = buildPaths(profile);
  return (
    <View style={styles.wrap}>
      <View style={styles.stats}>
        <MaterialCommunityIcons name="arrow-top-right" size={14} color={colors.success} />
        <Text style={styles.statText}>{Math.round(profile.gain)} m</Text>
        <MaterialCommunityIcons name="arrow-bottom-right" size={14} color={colors.danger} />
        <Text style={styles.statText}>{Math.round(profile.loss)} m</Text>
        <Text style={styles.statMuted}>
          {Math.round(profile.min)}–{Math.round(profile.max)} m rakım
        </Text>
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
