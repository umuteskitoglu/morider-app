import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { colors } from '../theme';

// Self-contained analog speedometer drawn in a fixed 200×200 viewBox and scaled
// to `size`. The arc spans 240° (8 o'clock → over the top → 4 o'clock), leaving
// a gap at the bottom, like a car/bike cluster.
const VB = 200;
const CX = 100;
const CY = 100;
const R = 84;
const START = 150; // degrees, native SVG (0 = 3 o'clock, clockwise positive)
const SWEEP = 240; // total arc, 0 → max
const MAJOR_STEPS = 6; // labelled ticks at 0, max/6, … max

// SVG-native polar: 0°=3 o'clock, angle grows clockwise (y is down).
function polar(angle: number, radius: number) {
  const rad = (angle * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

// Arc path from startAngle to endAngle (endAngle ≥ startAngle), clockwise.
function arc(startAngle: number, endAngle: number, radius: number): string {
  const s = polar(startAngle, radius);
  const e = polar(endAngle, radius);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

type Props = {
  /** current speed in km/h */
  value: number;
  /** full-scale speed in km/h */
  max?: number;
  /** rendered width/height in px */
  size?: number;
};

export function SpeedDial({ value, max = 180, size = 260 }: Props) {
  const clamped = Math.max(0, Math.min(value, max));
  const angleFor = (v: number) => START + (v / max) * SWEEP;
  const valueAngle = angleFor(clamped);
  // Danger zone: top 15% of the scale drawn in the alert colour.
  const dangerStart = angleFor(max * 0.85);

  const needle = polar(valueAngle, R - 22);
  const needleTail = polar(valueAngle + 180, 12);

  const ticks = [];
  for (let i = 0; i <= MAJOR_STEPS; i++) {
    const v = (max / MAJOR_STEPS) * i;
    const a = angleFor(v);
    const outer = polar(a, R);
    const inner = polar(a, R - 13);
    const label = polar(a, R - 30);
    ticks.push(
      <G key={`t${i}`}>
        <Line
          x1={outer.x}
          y1={outer.y}
          x2={inner.x}
          y2={inner.y}
          stroke={colors.text}
          strokeWidth={2}
        />
        <SvgText
          x={label.x}
          y={label.y + 3}
          fill={colors.textMuted}
          fontSize={11}
          fontWeight="700"
          textAnchor="middle"
        >
          {Math.round(v)}
        </SvgText>
      </G>,
    );
    // minor tick halfway to the next major
    if (i < MAJOR_STEPS) {
      const am = angleFor(v + max / MAJOR_STEPS / 2);
      const o = polar(am, R);
      const inn = polar(am, R - 7);
      ticks.push(
        <Line key={`m${i}`} x1={o.x} y1={o.y} x2={inn.x} y2={inn.y} stroke={colors.border} strokeWidth={1.5} />,
      );
    }
  }

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* track */}
        <Path d={arc(START, START + SWEEP, R)} stroke={colors.border} strokeWidth={6} fill="none" strokeLinecap="round" />
        {/* filled value arc */}
        <Path
          d={arc(START, valueAngle, R)}
          stroke={colors.primary}
          strokeWidth={6}
          fill="none"
          strokeLinecap="round"
        />
        {/* danger zone */}
        <Path d={arc(dangerStart, START + SWEEP, R)} stroke={colors.danger} strokeWidth={6} fill="none" strokeLinecap="round" />
        {ticks}
        {/* needle */}
        <Line
          x1={needleTail.x}
          y1={needleTail.y}
          x2={needle.x}
          y2={needle.y}
          stroke={colors.accent}
          strokeWidth={4}
          strokeLinecap="round"
        />
        <Circle cx={CX} cy={CY} r={9} fill={colors.surfaceAlt} stroke={colors.accent} strokeWidth={2} />
      </Svg>
      {/* crisp digital readout centred over the dial */}
      <View pointerEvents="none" style={styles.readout}>
        <Text style={[styles.value, { fontSize: size * 0.2 }]}>{Math.round(value)}</Text>
        <Text style={styles.unit}>km/s</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: '14%',
  },
  value: { color: colors.text, fontWeight: '900' },
  unit: { color: colors.textMuted, fontSize: 13, fontWeight: '700', letterSpacing: 1, marginTop: -2 },
});
