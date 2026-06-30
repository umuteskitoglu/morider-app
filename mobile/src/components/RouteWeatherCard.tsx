import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../theme';

// Matches the backend response of GET /api/routes/:id/weather (route/weather.go).
export type Rideability = {
  score: number;
  level: 'good' | 'caution' | 'poor';
  warnings: string[];
};

export type RideWeather = {
  temp_c: number;
  feels_like_c: number;
  precip_mm: number;
  wind_kph: number;
  gust_kph: number;
  wind_dir: number;
  visibility_m: number;
  weather_code: number;
};

export type PointWeather = {
  lat: number;
  lon: number;
  dist: number;
  weather: RideWeather;
  rideability: Rideability;
};

export type RouteWeather = {
  points: PointWeather[];
  overall: Rideability;
};

const LEVEL: Record<Rideability['level'], { color: string; icon: any; label: string }> = {
  good: { color: colors.success, icon: 'motorbike', label: 'Sürüşe uygun' },
  caution: { color: colors.warning, icon: 'alert', label: 'Dikkatli sürün' },
  poor: { color: colors.danger, icon: 'alert-octagon', label: 'Sürüş riskli' },
};

/** Compact route weather: an overall rideability badge, conditions at the start
 *  point, and any active hazard warnings. Renders nothing without data. */
export function RouteWeatherCard({ weather }: { weather: RouteWeather }) {
  if (!weather.points || weather.points.length === 0) return null;
  const start = weather.points[0].weather;
  const lvl = LEVEL[weather.overall.level] ?? LEVEL.caution;

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={[styles.badge, { borderColor: lvl.color }]}>
          <MaterialCommunityIcons name={lvl.icon} size={16} color={lvl.color} />
          <Text style={[styles.score, { color: lvl.color }]}>{weather.overall.score}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: lvl.color }]}>{lvl.label}</Text>
          <Text style={styles.cond}>
            {Math.round(start.temp_c)}°C · {Math.round(start.wind_kph)} km/s rüzgar
          </Text>
        </View>
      </View>

      {weather.overall.warnings.length > 0 && (
        <View style={styles.warnings}>
          {weather.overall.warnings.map((w, i) => (
            <View key={i} style={styles.warnRow}>
              <MaterialCommunityIcons name="circle" size={6} color={lvl.color} />
              <Text style={styles.warnText}>{w}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  score: { fontSize: 16, fontWeight: '900' },
  label: { fontSize: 13, fontWeight: '800' },
  cond: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  warnings: { marginTop: spacing.sm, gap: 4 },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  warnText: { color: colors.text, fontSize: 12 },
});
