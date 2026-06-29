import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { formatDistanceM, NavStep, stepIcon } from '../lib/navigation';
import { colors, radius, shadow, spacing } from '../theme';

/**
 * Google-Maps-style instruction banner: big arrow, distance to the maneuver
 * and the Turkish instruction. Tapping the speaker toggles voice guidance.
 */
export function NavBanner({
  step,
  distM,
  voiceOn,
  onToggleVoice,
  nextStep,
}: {
  step: NavStep;
  distM: number;
  voiceOn: boolean;
  onToggleVoice: () => void;
  nextStep?: NavStep | null;
}) {
  // "Sağa dön - Rıhtım Caddesi" → main text + road line.
  const [main, road] = step.instruction.split(' - ');
  const nextMain = nextStep ? nextStep.instruction.split(' - ')[0] : '';
  return (
    <View style={styles.banner}>
      <View style={styles.topRow}>
        <View style={styles.arrowBox}>
          <MaterialCommunityIcons name={stepIcon(step.type, step.modifier) as any} size={34} color="#fff" />
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
        <Pressable onPress={onToggleVoice} hitSlop={10} style={styles.voiceBtn}>
          <MaterialCommunityIcons
            name={voiceOn ? 'volume-high' : 'volume-off'}
            size={22}
            color={voiceOn ? colors.primary : colors.textMuted}
          />
        </Pressable>
      </View>
      {nextStep ? (
        <View style={styles.nextRow}>
          <MaterialCommunityIcons name={stepIcon(nextStep.type, nextStep.modifier) as any} size={16} color={colors.textMuted} />
          <Text style={styles.nextText} numberOfLines={1}>
            Sonra: {nextMain}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    backgroundColor: 'rgba(18,24,38,0.96)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.card,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  nextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  nextText: { color: colors.textMuted, fontSize: 13, fontWeight: '600', flex: 1 },
  arrowBox: {
    width: 54,
    height: 54,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  distance: { color: colors.primary, fontSize: 20, fontWeight: '900' },
  instruction: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: 1 },
  road: { color: colors.textMuted, fontSize: 13, marginTop: 1 },
  voiceBtn: { padding: spacing.xs },
});
