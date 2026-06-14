import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';

import { colors, gradients, spacing } from '../theme';

// Engine "rev" played on cold start. Currently a real supersport recording
// (Kawasaki ZX-6R, CC BY 3.0 — see assets/CREDITS.md). Drop a genuine S1000RR
// clip in at the same path to swap it; keep it short (~3-4s) and m4a/mp3/wav.
const engineSound = require('../../assets/s1000rr.m4a');

const GAUGE = 168;
const SWEEP = 118; // needle swings between -SWEEP and +SWEEP degrees
const TICKS = 30; // tick marks around the dial
const REDLINE = 0.72; // fraction of the sweep where the redline zone begins

// tachZoneColor mimics a real RPM dial: green low-rev, amber mid, orange high,
// and a hot red redline at the very top end.
function tachZoneColor(frac: number): string {
  if (frac >= REDLINE) return colors.danger; // redline
  if (frac >= 0.45) return colors.primary; // high
  if (frac >= 0.22) return colors.accent; // mid
  return colors.success; // low
}

// SplashOverlay is a one-shot launch animation styled as a tachometer revving
// into the redline: the dial ticks light up green→amber→red as the needle
// sweeps and the engine sound climbs, then the overlay fades and calls onFinish.
export default function SplashOverlay({ onFinish }: { onFinish: () => void }) {
  const player = useAudioPlayer(engineSound);

  const fade = useRef(new Animated.Value(1)).current; // overlay opacity (1 -> 0)
  const logoIn = useRef(new Animated.Value(0)).current; // wordmark intro
  const rev = useRef(new Animated.Value(0)).current; // tach sweep 0..1

  useEffect(() => {
    // Audio is best-effort: a failure (no asset, silent switch, etc.) must never
    // block the visual splash from completing.
    try {
      player.play();
    } catch {
      // ignore
    }

    Animated.spring(logoIn, { toValue: 1, friction: 6, tension: 70, useNativeDriver: true }).start();

    // Needle sweep follows the engine curve: blip up, settle, climb into the
    // redline, hold. Driven on the JS thread (useNativeDriver:false) so the same
    // value can feed rotation, colors and the redline bar width together.
    Animated.sequence([
      Animated.timing(rev, { toValue: 0.5, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.timing(rev, { toValue: 0.18, duration: 300, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(rev, { toValue: 1, duration: 950, easing: Easing.in(Easing.quad), useNativeDriver: false }),
    ]).start();

    const t = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 420, useNativeDriver: true }).start(({ finished }) => {
        if (finished) onFinish();
      });
    }, 2300);

    return () => clearTimeout(t);
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needleRotate = rev.interpolate({ inputRange: [0, 1], outputRange: [`-${SWEEP}deg`, `${SWEEP}deg`] });
  const barWidth = rev.interpolate({ inputRange: [0, 1], outputRange: ['4%', '100%'] });
  // Needle and glow ride the heat: cool accent → orange → red as revs climb.
  const hot = rev.interpolate({
    inputRange: [0, 0.5, REDLINE, 1],
    outputRange: [colors.accent, colors.primary, colors.danger, colors.danger],
  });
  const ringOpacity = rev.interpolate({ inputRange: [0, 0.5, REDLINE, 1], outputRange: [0.12, 0.4, 0.7, 0.95] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]} pointerEvents="none">
      <LinearGradient colors={gradients.hero} style={StyleSheet.absoluteFill} />

      <Animated.View
        style={[
          styles.center,
          { opacity: logoIn, transform: [{ scale: logoIn.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] },
        ]}
      >
        {/* Tachometer */}
        <View style={styles.gauge}>
          <Animated.View style={[styles.glowRing, { opacity: ringOpacity, borderColor: hot }]} />

          {/* RPM tick marks: each lights up to its zone colour as the needle passes. */}
          {Array.from({ length: TICKS }).map((_, i) => {
            const frac = i / (TICKS - 1);
            const angle = -SWEEP + 2 * SWEEP * frac;
            const isRed = frac >= REDLINE;
            return (
              <View key={i} style={[styles.tickWrap, { transform: [{ rotate: `${angle}deg` }] }]} pointerEvents="none">
                <Animated.View
                  style={[
                    styles.tick,
                    isRed && styles.tickRed,
                    {
                      backgroundColor: tachZoneColor(frac),
                      opacity: rev.interpolate({
                        inputRange: [Math.max(0, frac - 0.03), frac + 0.01],
                        outputRange: [0.16, 1],
                        extrapolate: 'clamp',
                      }),
                    },
                  ]}
                />
              </View>
            );
          })}

          <MaterialCommunityIcons name="motorbike" size={38} color={colors.text} style={styles.bike} />

          {/* Needle pivots at the dial centre as the wrapper rotates. */}
          <Animated.View style={[styles.needleWrap, { transform: [{ rotate: needleRotate }] }]}>
            <Animated.View style={[styles.needle, { backgroundColor: hot }]} />
          </Animated.View>
          <Animated.View style={[styles.hub, { borderColor: hot }]} />
        </View>

        <Text style={styles.brand}>MORIDER</Text>
      </Animated.View>

      {/* Redline bar: a fixed green→amber→red gradient revealed as it fills, so it
          visibly climbs into the red. */}
      <View style={styles.barTrack}>
        <Animated.View style={{ width: barWidth, height: '100%' }}>
          <LinearGradient
            colors={[colors.success, colors.accent, colors.primary, colors.danger]}
            locations={[0, 0.45, 0.72, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.barFill}
          />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', zIndex: 999 },
  center: { alignItems: 'center' },
  gauge: {
    width: GAUGE,
    height: GAUGE,
    borderRadius: GAUGE / 2,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  glowRing: {
    position: 'absolute',
    width: GAUGE + 18,
    height: GAUGE + 18,
    borderRadius: (GAUGE + 18) / 2,
    borderWidth: 6,
  },
  // Each tick sits at the top of a full-dial wrapper that is rotated into place.
  tickWrap: { position: 'absolute', width: GAUGE, height: GAUGE, alignItems: 'center' },
  tick: { position: 'absolute', top: 6, width: 3, height: 12, borderRadius: 2 },
  tickRed: { width: 4, height: 15 },
  bike: { position: 'absolute', top: 34 },
  needleWrap: { position: 'absolute', width: GAUGE, height: GAUGE, alignItems: 'center' },
  needle: { position: 'absolute', top: 22, width: 4, height: GAUGE / 2 - 18, borderRadius: 2 },
  hub: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.bg, borderWidth: 3 },
  brand: { color: colors.text, fontSize: 36, fontWeight: '900', letterSpacing: 4 },
  barTrack: {
    position: 'absolute',
    bottom: 64,
    left: spacing.xl,
    right: spacing.xl,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  barFill: { flex: 1, borderRadius: 3 },
});
