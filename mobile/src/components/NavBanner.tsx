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
}: {
  step: NavStep;
  distM: number;
  voiceOn: boolean;
  onToggleVoice: () => void;
}) {
  // "Sağa dön - Rıhtım Caddesi" → main text + road line.
  const [main, road] = step.instruction.split(' - ');
  return (
    <View style={styles.banner}>
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
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(18,24,38,0.96)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.card,
  },
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
