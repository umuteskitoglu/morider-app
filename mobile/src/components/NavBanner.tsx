import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { formatDistanceM, NavStep, stepIcon } from '../lib/navigation';
import { radius, shadow, spacing } from '../theme';

// Google-navigation palette: a rich blue maneuver header with a translucent
// "then" footer strip.
const NAV_BLUE = '#1A73E8';
const NAV_BLUE_DARK = '#1257B8';

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
  // "Sağa dön - Rıhtım Caddesi" → main text + road line.
  const [main, road] = step.instruction.split(' - ');
  const nextMain = nextStep ? nextStep.instruction.split(' - ')[0] : '';
  return (
    <View style={[styles.card, { paddingTop: topInset + spacing.sm }]}>
      <View style={styles.topRow}>
        <View style={styles.arrowBox}>
          <MaterialCommunityIcons name={stepIcon(step.type, step.modifier) as any} size={40} color="#fff" />
        </View>
        <View style={styles.flex}>
          <Text style={styles.distance}>{formatDistanceM(distM)}</Text>
          <Text style={styles.instruction} numberOfLines={2}>
            {road || main}
          </Text>
        </View>
        <Pressable onPress={onToggleVoice} hitSlop={10} style={styles.voiceBtn}>
          <MaterialCommunityIcons name={voiceOn ? 'volume-high' : 'volume-off'} size={24} color="#fff" />
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
  arrowBox: { width: 52, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  distance: { color: '#fff', fontSize: 30, fontWeight: '900', letterSpacing: -0.5 },
  instruction: { color: '#eaf1fd', fontSize: 16, fontWeight: '700', marginTop: 1 },
  voiceBtn: { padding: spacing.xs },
  nextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: NAV_BLUE_DARK,
  },
  nextLabel: { color: '#9dc1f6', fontSize: 11, fontWeight: '900', letterSpacing: 1, marginRight: spacing.xs },
  nextText: { color: '#cfe0fb', fontSize: 14, fontWeight: '700', flex: 1 },
});
