import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { Button } from './ui';
import { SpeedDial } from './SpeedDial';
import { useLeanAngle } from '../lib/useLeanAngle';
import { colors, radius, shadow, spacing } from '../theme';

export type DashSample = {
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number; // m/s
  ts: string;
};

type GaugeKey = 'speed' | 'lean' | 'elev' | 'trip';

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
  lean: 'angle-acute',
  elev: 'image-filter-hdr',
  trip: 'timer-outline',
};
const LABELS: Record<GaugeKey, string> = {
  speed: 'Hız',
  lean: 'Yatış',
  elev: 'İrtifa',
  trip: 'Sürüş',
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
  const [focused, setFocused] = useState<GaugeKey>('speed');
  const [elapsed, setElapsed] = useState(0);
  const { lean, maxLean, calibrate } = useLeanAngle(true);
  // Peak speed over the whole ride (samples store m/s); persists across toggles.
  const maxSpeed = Math.max(speed, ...samples.map((s) => s.speed * 3.6), 0);

  // 1 s ticker for the ride clock + derived averages.
  useEffect(() => {
    const update = () => setElapsed(startedAt ? Date.now() - startedAt.getTime() : 0);
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const hours = elapsed / 3_600_000;
  const avg = hours > 0.0003 ? distance / hours : 0;
  const g = grade(samples);

  const meta: Record<GaugeKey, { value: string; unit: string }> = {
    speed: { value: `${Math.round(speed)}`, unit: 'km/s' },
    lean: { value: `${Math.abs(Math.round(lean))}°`, unit: lean >= 0 ? 'sağ' : 'sol' },
    elev: { value: `${Math.round(altitude)}`, unit: 'm' },
    trip: { value: fmtElapsed(elapsed), unit: `${distance.toFixed(1)} km` },
  };

  const others = (['speed', 'lean', 'elev', 'trip'] as GaugeKey[]).filter((k) => k !== focused);

  return (
    <View style={styles.root}>
      {/* header */}
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={onClose} hitSlop={8}>
          <MaterialCommunityIcons name="map-outline" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.clock}>
          <View style={[styles.dot, { backgroundColor: recording ? colors.danger : colors.textMuted }]} />
          <Text style={styles.clockText}>{fmtElapsed(elapsed)}</Text>
        </View>
        <View style={styles.iconBtn} />
      </View>

      {/* primary (big) slot */}
      <View style={styles.primary}>
        {focused === 'speed' && <SpeedBig speed={speed} heading={heading} maxSpeed={maxSpeed} />}
        {focused === 'lean' && <LeanBig lean={lean} maxLean={maxLean} onCalibrate={calibrate} />}
        {focused === 'elev' && <ElevBig altitude={altitude} grade={g} samples={samples} />}
        {focused === 'trip' && <TripBig elapsed={elapsed} distance={distance} maxSpeed={maxSpeed} avg={avg} />}
      </View>

      {/* secondary tiles — tap to promote into the big slot */}
      <View style={styles.tiles}>
        {others.map((k) => (
          <Pressable key={k} style={styles.tile} onPress={() => setFocused(k)}>
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

// Roll/lean indicator: a pointer tilting from vertical by the lean angle.
function LeanBig({ lean, maxLean, onCalibrate }: { lean: number; maxLean: number; onCalibrate: () => void }) {
  const VB = 200;
  const cx = 100;
  const cy = 120;
  const r = 86;
  const polar = (angle: number, radius: number) => {
    const rad = (angle * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  };
  // Up is 270° (native, clockwise-positive); right lean adds clockwise.
  const clamped = Math.max(-50, Math.min(50, lean));
  const tip = polar(270 + clamped, r);
  const ticks = [-45, -30, -15, 0, 15, 30, 45].map((t) => {
    const a = 270 + t;
    const o = polar(a, r);
    const inn = polar(a, r - (t === 0 ? 16 : 10));
    return (
      <Line key={t} x1={o.x} y1={o.y} x2={inn.x} y2={inn.y} stroke={t === 0 ? colors.text : colors.border} strokeWidth={t === 0 ? 2.5 : 1.5} />
    );
  });
  return (
    <View style={styles.center}>
      <View style={{ width: 280, height: 220 }}>
        <Svg width={280} height={220} viewBox={`0 0 ${VB} ${VB - 20}`}>
          <Path
            d={`M ${polar(220, r).x} ${polar(220, r).y} A ${r} ${r} 0 0 1 ${polar(320, r).x} ${polar(320, r).y}`}
            stroke={colors.border}
            strokeWidth={5}
            fill="none"
            strokeLinecap="round"
          />
          {ticks}
          <Line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke={colors.accent} strokeWidth={5} strokeLinecap="round" />
          <Circle cx={cx} cy={cy} r={8} fill={colors.surfaceAlt} stroke={colors.accent} strokeWidth={2} />
          <SvgText x={cx} y={cy + 34} fill={colors.text} fontSize={34} fontWeight="900" textAnchor="middle">
            {Math.abs(Math.round(lean))}°
          </SvgText>
          <SvgText x={cx} y={cy + 52} fill={colors.textMuted} fontSize={12} fontWeight="700" textAnchor="middle">
            {Math.abs(lean) < 2 ? 'DİK' : lean >= 0 ? 'SAĞA' : 'SOLA'}
          </SvgText>
        </Svg>
      </View>
      <View style={styles.subRow}>
        <Caption icon="arrow-expand-horizontal" text={`Max ${Math.round(maxLean)}°`} />
        <Pressable style={styles.calBtn} onPress={onCalibrate} hitSlop={6}>
          <MaterialCommunityIcons name="crosshairs" size={15} color={colors.text} />
          <Text style={styles.calText}>Dik konumu sıfırla</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>Yatış açısı yaklaşıktır</Text>
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
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bg, paddingTop: 52, paddingBottom: spacing.lg },
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
  calBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  calText: { color: colors.text, fontSize: 13, fontWeight: '700' },
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
  tileLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  footer: { paddingHorizontal: spacing.md, marginTop: spacing.md },
});
