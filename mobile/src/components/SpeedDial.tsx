import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Polygon,
  RadialGradient,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import { colors } from '../theme';

// Aggressive "Need for Speed" cluster: a 240° arc (8 o'clock → over the top →
// 4 o'clock) drawn in a fixed 200×200 viewBox and scaled to `size`. The value
// sweep runs a cyan→amber→red gradient that goes hotter as the rider pushes,
// with a bloom glow, a redline zone and a blade needle.
const VB = 200;
const CX = 100;
const CY = 100;
const R = 82;
const START = 150; // degrees, native SVG (0 = 3 o'clock, clockwise positive)
const SWEEP = 240; // total arc, 0 → max
const MAJOR_STEPS = 6; // labelled ticks at 0, max/6, … max
const REDLINE = 0.82; // fraction of full scale where the danger zone begins

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
  const frac = clamped / max;
  const hot = frac >= REDLINE; // in the redline → everything turns molten red
  const angleFor = (v: number) => START + (v / max) * SWEEP;
  const valueAngle = angleFor(clamped);
  const redlineAngle = angleFor(max * REDLINE);

  // Blade needle: a slim kite from a long tip to a short tail, so it reads like
  // a tachometer pointer rather than a plain line.
  const tip = polar(valueAngle, R - 12);
  const tail = polar(valueAngle + 180, 18);
  const hubL = polar(valueAngle + 90, 6);
  const hubR = polar(valueAngle - 90, 6);
  const needlePts = `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${hubL.x.toFixed(1)},${hubL.y.toFixed(1)} ${tail.x.toFixed(1)},${tail.y.toFixed(1)} ${hubR.x.toFixed(1)},${hubR.y.toFixed(1)}`;
  const needleColor = hot ? colors.danger : colors.accent;

  const ticks = [];
  for (let i = 0; i <= MAJOR_STEPS; i++) {
    const v = (max / MAJOR_STEPS) * i;
    const a = angleFor(v);
    const inRed = v / max >= REDLINE - 1e-6;
    const tickColor = inRed ? colors.danger : colors.text;
    const outer = polar(a, R + 4);
    const inner = polar(a, R - 12);
    const label = polar(a, R - 28);
    ticks.push(
      <G key={`t${i}`}>
        <Line x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke={tickColor} strokeWidth={3} strokeLinecap="round" />
        <SvgText
          x={label.x}
          y={label.y + 4}
          fill={inRed ? colors.danger : colors.textMuted}
          fontSize={12}
          fontWeight="900"
          fontStyle="italic"
          textAnchor="middle"
        >
          {Math.round(v)}
        </SvgText>
      </G>,
    );
    // minor tick halfway to the next major
    if (i < MAJOR_STEPS) {
      const vm = v + max / MAJOR_STEPS / 2;
      const am = angleFor(vm);
      const o = polar(am, R + 2);
      const inn = polar(am, R - 6);
      ticks.push(
        <Line
          key={`m${i}`}
          x1={o.x}
          y1={o.y}
          x2={inn.x}
          y2={inn.y}
          stroke={vm / max >= REDLINE ? colors.danger : colors.borderStrong}
          strokeWidth={1.5}
        />,
      );
    }
  }

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Defs>
          {/* Speed sweep, left(slow)→right(fast): cool cyan ramping to molten red. */}
          <LinearGradient id="speedSweep" gradientUnits="userSpaceOnUse" x1={16} y1={0} x2={184} y2={0}>
            <Stop offset="0" stopColor={colors.cyan} />
            <Stop offset="0.4" stopColor={colors.accent} />
            <Stop offset="0.72" stopColor={colors.primary} />
            <Stop offset="1" stopColor={colors.danger} />
          </LinearGradient>
          {/* Carbon depth behind the dial. */}
          <RadialGradient id="dialBase" cx="50%" cy="42%" r="65%">
            <Stop offset="0" stopColor={colors.surfaceAlt} />
            <Stop offset="1" stopColor={colors.bg} />
          </RadialGradient>
        </Defs>

        {/* recessed carbon face + thin tech ring */}
        <Circle cx={CX} cy={CY} r={R + 14} fill="url(#dialBase)" />
        <Circle cx={CX} cy={CY} r={R + 14} fill="none" stroke={colors.border} strokeWidth={1.5} />

        {/* dark track */}
        <Path d={arc(START, START + SWEEP, R)} stroke={colors.surfaceHi} strokeWidth={9} fill="none" strokeLinecap="round" />

        {/* glow bloom under the live value (wider, faint) */}
        {clamped > 0 && (
          <Path
            d={arc(START, valueAngle, R)}
            stroke={hot ? colors.danger : colors.primary}
            strokeWidth={18}
            strokeOpacity={0.22}
            fill="none"
            strokeLinecap="round"
          />
        )}
        {/* filled value arc with the speed gradient */}
        {clamped > 0 && (
          <Path d={arc(START, valueAngle, R)} stroke="url(#speedSweep)" strokeWidth={9} fill="none" strokeLinecap="round" />
        )}

        {/* redline zone marker on the outer edge */}
        <Path d={arc(redlineAngle, START + SWEEP, R + 9)} stroke={colors.danger} strokeWidth={3} fill="none" strokeLinecap="round" />

        {ticks}

        {/* needle glow + blade */}
        <Line
          x1={tail.x}
          y1={tail.y}
          x2={tip.x}
          y2={tip.y}
          stroke={needleColor}
          strokeWidth={9}
          strokeOpacity={0.25}
          strokeLinecap="round"
        />
        <Polygon points={needlePts} fill={needleColor} />
        <Circle cx={CX} cy={CY} r={11} fill={colors.surfaceAlt} stroke={needleColor} strokeWidth={2.5} />
        <Circle cx={CX} cy={CY} r={3.5} fill={needleColor} />
      </Svg>

      {/* crisp digital readout centred over the dial */}
      <View pointerEvents="none" style={styles.readout}>
        <Text style={[styles.value, { fontSize: size * 0.21 }, hot && styles.valueHot]}>{Math.round(value)}</Text>
        <Text style={[styles.unit, hot && styles.unitHot]}>KM/S</Text>
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
    paddingTop: '32%',
  },
  value: {
    color: colors.text,
    fontWeight: '900',
    fontStyle: 'italic',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(255,106,26,0.55)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  valueHot: {
    color: '#FFE3DC',
    textShadowColor: 'rgba(255,77,77,0.7)',
  },
  unit: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '900',
    fontStyle: 'italic',
    letterSpacing: 3,
    marginTop: -2,
  },
  unitHot: { color: colors.danger },
});
