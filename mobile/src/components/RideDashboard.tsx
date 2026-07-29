import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { Button } from './ui';
import { SpeedDial } from './SpeedDial';
import { Rideability, RideWeather } from './RouteWeatherCard';
import { api } from '../api/client';
import { colors, radius, shadow, spacing } from '../theme';

export type DashSample = {
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number; // m/s
  ts: string;
};

// No 'lean' gauge. A live max-lean readout rewards glancing at the phone in
// the middle of a corner, which is the single most dangerous moment to do it.
// Peak lean is still recorded for the ride and shown in the post-ride summary.
type GaugeKey = 'speed' | 'elev' | 'trip' | 'weather';

type Props = {
  speed: number; // km/h
  heading: number; // degrees, -1 if unknown
  altitude: number; // m
  distance: number; // km
  samples: DashSample[];
  startedAt: Date | null;
  recording: boolean;
  saving?: boolean;
  onClose: () => void;
  onStop: () => void;
};

const ICONS: Record<GaugeKey, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  speed: 'speedometer',
  elev: 'image-filter-hdr',
  trip: 'timer-outline',
  weather: 'weather-partly-cloudy',
};
const LABELS: Record<GaugeKey, string> = {
  speed: 'Hız',
  elev: 'İrtifa',
  trip: 'Sürüş',
  weather: 'Hava',
};

const WX_LEVEL: Record<Rideability['level'], { color: string; icon: any; label: string }> = {
  good: { color: colors.success, icon: 'motorbike', label: 'Sürüşe uygun' },
  caution: { color: colors.warning, icon: 'alert', label: 'Dikkatli sürün' },
  poor: { color: colors.danger, icon: 'alert-octagon', label: 'Sürüş riskli' },
};

function haversineM(a: DashSample, b: DashSample): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Road grade % from the recent track: walk back ~40 m and compare altitude.
function grade(samples: DashSample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let run = 0;
  for (let i = samples.length - 2; i >= 0; i--) {
    run += haversineM(samples[i + 1], samples[i]);
    if (run >= 40) {
      const rise = last.altitude - samples[i].altitude;
      return run > 0 ? (rise / run) * 100 : 0;
    }
  }
  return 0;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const COMPASS = ['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'];
function cardinal(heading: number): string {
  if (heading < 0) return '--';
  return COMPASS[Math.round(heading / 45) % 8];
}

export function RideDashboard({
  speed,
  heading,
  altitude,
  distance,
  samples,
  startedAt,
  recording,
  saving,
  onClose,
  onStop,
}: Props) {
  const insets = useSafeAreaInsets();
  const [focused, setFocused] = useState<GaugeKey>('speed');
  const [elapsed, setElapsed] = useState(0);
  const [wx, setWx] = useState<{ weather: RideWeather; rideability: Rideability } | null>(null);
  // Peak speed over the whole ride, carried forward incrementally. Recomputing
  // it from `samples` on every render meant spreading the whole track into
  // Math.max once a second — O(n) per frame, and a hard RangeError crash once
  // the track passed the argument limit on a long ride. Seeded once from any
  // samples that already exist (dashboard opened mid-ride).
  const maxSpeedRef = useRef<number | null>(null);
  if (maxSpeedRef.current === null) {
    let seed = 0;
    for (const s of samples) if (s.speed * 3.6 > seed) seed = s.speed * 3.6;
    maxSpeedRef.current = seed;
  }
  if (speed > maxSpeedRef.current) maxSpeedRef.current = speed;
  const maxSpeed = maxSpeedRef.current;

  // 1 s ticker for the ride clock + derived averages.
  useEffect(() => {
    const update = () => setElapsed(startedAt ? Date.now() - startedAt.getTime() : 0);
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Fetch current conditions for the live position, refreshed every ~10 min.
  // Best effort: the weather gauge just shows a placeholder until it lands.
  const last = samples[samples.length - 1];
  const lat = last?.latitude;
  const lon = last?.longitude;
  useEffect(() => {
    if (lat == null || lon == null) return;
    let active = true;
    const fetchWx = async () => {
      try {
        const { data } = await api.get('/api/weather', { params: { lat, lon } });
        if (active) setWx({ weather: data.weather, rideability: data.rideability });
      } catch {
        // ignore
      }
    };
    fetchWx();
    const id = setInterval(fetchWx, 10 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
    // Re-key on a coarse position (~1 km) so we don't refetch on every GPS tick.
  }, [lat != null ? lat.toFixed(2) : null, lon != null ? lon.toFixed(2) : null]);

  const hours = elapsed / 3_600_000;
  const avg = hours > 0.0003 ? distance / hours : 0;
  const g = grade(samples);

  const meta: Record<GaugeKey, { value: string; unit: string }> = {
    speed: { value: `${Math.round(speed)}`, unit: 'km/s' },
    elev: { value: `${Math.round(altitude)}`, unit: 'm' },
    trip: { value: fmtElapsed(elapsed), unit: `${distance.toFixed(1)} km` },
    weather: { value: wx ? `${Math.round(wx.weather.temp_c)}°` : '--', unit: wx ? `${wx.rideability.score}/100` : 'hava' },
  };

  const others = (['speed', 'elev', 'trip', 'weather'] as GaugeKey[]).filter((k) => k !== focused);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.md }]}>
      {/* header */}
      <View style={styles.header}>
        <Pressable
          style={styles.iconBtn}
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Haritaya dön"
        >
          <MaterialCommunityIcons name="map-outline" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.clock} accessibilityRole="text" accessibilityLabel={`Sürüş süresi ${fmtElapsed(elapsed)}`}>
          <View style={[styles.dot, { backgroundColor: recording ? colors.danger : colors.textMuted }]} />
          <Text style={styles.clockText}>{fmtElapsed(elapsed)}</Text>
        </View>
        <View style={styles.iconBtn} />
      </View>

      {/* primary (big) slot */}
      <View style={styles.primary}>
        {focused === 'speed' && <SpeedBig speed={speed} heading={heading} maxSpeed={maxSpeed} />}
        {focused === 'elev' && <ElevBig altitude={altitude} grade={g} samples={samples} />}
        {focused === 'trip' && <TripBig elapsed={elapsed} distance={distance} maxSpeed={maxSpeed} avg={avg} />}
        {focused === 'weather' && <WeatherBig wx={wx} />}
      </View>

      {/* secondary tiles — tap to promote into the big slot */}
      <View style={styles.tiles}>
        {others.map((k) => (
          <Pressable
            key={k}
            style={styles.tile}
            onPress={() => setFocused(k)}
            accessibilityRole="button"
            accessibilityLabel={`${LABELS[k]}: ${meta[k].value} ${meta[k].unit}. Büyük göstergeye al.`}
          >
            <MaterialCommunityIcons name={ICONS[k]} size={18} color={colors.primary} />
            <Text style={styles.tileValue} numberOfLines={1}>
              {meta[k].value}
            </Text>
            <Text style={styles.tileLabel}>
              {LABELS[k]} · {meta[k].unit}
            </Text>
          </Pressable>
        ))}
      </View>

      {recording && (
        <View style={styles.footer}>
          <Button title="Sürüşü Bitir" variant="danger" icon="stop-circle" onPress={onStop} loading={saving} />
        </View>
      )}
    </View>
  );
}

function SpeedBig({ speed, heading, maxSpeed }: { speed: number; heading: number; maxSpeed: number }) {
  return (
    <View style={styles.center}>
      <SpeedDial value={speed} size={280} />
      <View style={styles.subRow}>
        <Caption icon="compass-outline" text={`${cardinal(heading)}${heading >= 0 ? ` ${Math.round(heading)}°` : ''}`} />
        <Caption icon="speedometer-medium" text={`Max ${Math.round(maxSpeed)} km/s`} />
      </View>
    </View>
  );
}

function ElevBig({ altitude, grade, samples }: { altitude: number; grade: number; samples: DashSample[] }) {
  // Build a sparkline from the most recent altitude samples.
  const recent = samples.slice(-80);
  let spark = '';
  if (recent.length >= 2) {
    const alts = recent.map((s) => s.altitude);
    const min = Math.min(...alts);
    const range = Math.max(Math.max(...alts) - min, 10);
    spark =
      'M' +
      recent
        .map((s, i) => {
          const x = (i / (recent.length - 1)) * 100;
          const y = 32 - ((s.altitude - min) / range) * 28 - 2;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' L');
  }
  const up = grade >= 0;
  return (
    <View style={styles.center}>
      <Text style={styles.bigValue}>
        {Math.round(altitude)}
        <Text style={styles.bigUnit}> m</Text>
      </Text>
      <View style={styles.gradeRow}>
        <MaterialCommunityIcons
          name={up ? 'arrow-top-right' : 'arrow-bottom-right'}
          size={20}
          color={up ? colors.success : colors.danger}
        />
        <Text style={[styles.gradeText, { color: up ? colors.success : colors.danger }]}>
          %{Math.abs(grade).toFixed(1)} eğim
        </Text>
      </View>
      {spark ? (
        <Svg width={260} height={70} viewBox="0 0 100 32" preserveAspectRatio="none" style={{ marginTop: spacing.md }}>
          <Path d={`${spark} L100,32 L0,32 Z`} fill={colors.primary} opacity={0.18} />
          <Path d={spark} stroke={colors.primary} strokeWidth={0.8} fill="none" />
        </Svg>
      ) : (
        <Text style={styles.hint}>Profil için biraz daha sür</Text>
      )}
    </View>
  );
}

function TripBig({
  elapsed,
  distance,
  maxSpeed,
  avg,
}: {
  elapsed: number;
  distance: number;
  maxSpeed: number;
  avg: number;
}) {
  return (
    <View style={styles.tripGrid}>
      <TripCell icon="timer-outline" value={fmtElapsed(elapsed)} label="Süre" />
      <TripCell icon="map-marker-distance" value={`${distance.toFixed(2)}`} label="Mesafe (km)" />
      <TripCell icon="speedometer" value={`${Math.round(maxSpeed)}`} label="Max hız (km/s)" />
      <TripCell icon="speedometer-medium" value={`${Math.round(avg)}`} label="Ort. hız (km/s)" />
    </View>
  );
}

function TripCell({
  icon,
  value,
  label,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  value: string;
  label: string;
}) {
  return (
    <View style={styles.tripCell}>
      <MaterialCommunityIcons name={icon} size={22} color={colors.primary} />
      <Text style={styles.tripValue}>{value}</Text>
      <Text style={styles.tripLabel}>{label}</Text>
    </View>
  );
}

function WeatherBig({ wx }: { wx: { weather: RideWeather; rideability: Rideability } | null }) {
  if (!wx) {
    return (
      <View style={styles.center}>
        <MaterialCommunityIcons name="weather-cloudy-clock" size={64} color={colors.textMuted} />
        <Text style={styles.hint}>Hava durumu alınıyor…</Text>
      </View>
    );
  }
  const lvl = WX_LEVEL[wx.rideability.level] ?? WX_LEVEL.caution;
  return (
    <View style={styles.center}>
      <Text style={[styles.bigValue, { color: lvl.color }]}>
        {wx.rideability.score}
        <Text style={styles.bigUnit}> /100</Text>
      </Text>
      <View style={styles.gradeRow}>
        <MaterialCommunityIcons name={lvl.icon} size={20} color={lvl.color} />
        <Text style={[styles.gradeText, { color: lvl.color }]}>{lvl.label}</Text>
      </View>
      <View style={styles.subRow}>
        <Caption icon="thermometer" text={`${Math.round(wx.weather.temp_c)}°C`} />
        <Caption icon="weather-windy" text={`${Math.round(wx.weather.wind_kph)} km/s`} />
      </View>
      {wx.rideability.warnings.length > 0 && (
        <Text style={[styles.hint, { color: lvl.color, textAlign: 'center', paddingHorizontal: spacing.lg }]}>
          {wx.rideability.warnings.slice(0, 2).join(' · ')}
        </Text>
      )}
    </View>
  );
}

function Caption({
  icon,
  text,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  text: string;
}) {
  return (
    <View style={styles.caption}>
      <MaterialCommunityIcons name={icon} size={15} color={colors.textMuted} />
      <Text style={styles.captionText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // paddingTop/Bottom come from the safe-area insets at render time: the old
  // fixed 52pt sat under the Dynamic Island, and the fixed bottom padding put
  // the "end ride" button under the home indicator.
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clock: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 9, height: 9, borderRadius: 5 },
  clockText: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  primary: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  caption: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  captionText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  bigValue: { color: colors.text, fontSize: 88, fontWeight: '900', fontVariant: ['tabular-nums'] },
  bigUnit: { color: colors.textMuted, fontSize: 28, fontWeight: '800' },
  gradeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: -spacing.xs },
  gradeText: { fontSize: 18, fontWeight: '800' },
  tripGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  tripCell: {
    width: '42%',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    ...shadow.card,
  },
  tripValue: { color: colors.text, fontSize: 30, fontWeight: '900', marginTop: spacing.xs, fontVariant: ['tabular-nums'] },
  tripLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 2 },
  tiles: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.md },
  tile: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    gap: 2,
  },
  tileValue: { color: colors.text, fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  tileLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  footer: { paddingHorizontal: spacing.md, marginTop: spacing.md },
});
