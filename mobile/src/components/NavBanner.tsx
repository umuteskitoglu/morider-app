import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { formatDistanceM, NavStep, stepIcon } from '../lib/navigation';
import { radius, shadow, spacing } from '../theme';

// Google-navigation palette: a rich blue maneuver header with a translucent
// "then" footer strip. Darkened from #1A73E8 so the supporting text clears
// WCAG AA on it — at the lighter blue the "then" line measured 2.4:1, which
// disappears entirely in direct sunlight.
const NAV_BLUE = '#1557B0';
const NAV_BLUE_DARK = '#0E4691';
const NAV_TEXT_DIM = '#E8F0FE'; // 6.0:1 on NAV_BLUE

/**
 * Google-Maps-style maneuver header: edge-to-edge blue card pinned to the top
 * with a big arrow, the distance to the turn, the instruction/street and a
 * "then …" preview of the following maneuver. Tapping the speaker toggles voice.
 */
export function NavBanner({
  step,
  distM,
  voiceOn,
  onToggleVoice,
  nextStep,
  topInset = 0,
}: {
  step: NavStep;
  distM: number;
  voiceOn: boolean;
  onToggleVoice: () => void;
  nextStep?: NavStep | null;
  topInset?: number;
}) {
  // "Sağa dön - Rıhtım Caddesi" → maneuver line + road line. Both are shown:
  // the arrow alone can't tell a slight right from a sharp right or a
  // roundabout exit, and picking the wrong one mid-ride means a late, abrupt
  // correction.
  const [main, road] = step.instruction.split(' - ');
  const nextMain = nextStep ? nextStep.instruction.split(' - ')[0] : '';
  return (
    <View style={[styles.card, { paddingTop: topInset + spacing.sm }]}>
      <View style={styles.topRow}>
        <View style={styles.arrowBox}>
          <MaterialCommunityIcons name={stepIcon(step.type, step.modifier) as any} size={44} color="#fff" />
        </View>
        <View style={styles.flex}>
          <Text style={styles.distance}>{formatDistanceM(distM)}</Text>
          <Text style={styles.instruction} numberOfLines={1}>
            {main}
          </Text>
          {road ? (
            <Text style={styles.road} numberOfLines={1}>
              {road}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onToggleVoice}
          hitSlop={10}
          style={styles.voiceBtn}
          accessibilityRole="button"
          accessibilityLabel={voiceOn ? 'Sesli yönlendirme açık' : 'Sesli yönlendirme kapalı'}
          accessibilityState={{ selected: voiceOn }}
        >
          <MaterialCommunityIcons name={voiceOn ? 'volume-high' : 'volume-off'} size={26} color="#fff" />
        </Pressable>
      </View>
      {nextStep ? (
        <View style={styles.nextRow}>
          <Text style={styles.nextLabel}>SONRA</Text>
          <MaterialCommunityIcons name={stepIcon(nextStep.type, nextStep.modifier) as any} size={16} color="#cfe0fb" />
          <Text style={styles.nextText} numberOfLines={1}>
            {nextMain}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: NAV_BLUE,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    ...shadow.card,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  arrowBox: { width: 56, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  distance: { color: '#fff', fontSize: 34, fontWeight: '900', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  instruction: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 1 },
  road: { color: NAV_TEXT_DIM, fontSize: 16, fontWeight: '500', marginTop: 1 },
  voiceBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  nextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: NAV_BLUE_DARK,
  },
  nextLabel: { color: NAV_TEXT_DIM, fontSize: 13, fontWeight: '900', letterSpacing: 0.5, marginRight: spacing.xs },
  nextText: { color: NAV_TEXT_DIM, fontSize: 15, fontWeight: '700', flex: 1 },
});
