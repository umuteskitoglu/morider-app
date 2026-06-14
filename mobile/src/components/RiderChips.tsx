import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { bikeLabel, licenseLabel } from '../lib/rider';
import { colors, spacing } from '../theme';

/**
 * The licence + bike-type chip row shown on profiles. Renders nothing when the
 * rider has set neither, so callers can drop it in unconditionally.
 */
export function RiderChips({
  licenseType,
  bikeType,
  style,
}: {
  licenseType?: string;
  bikeType?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const license = licenseLabel(licenseType);
  const bike = bikeLabel(bikeType);
  if (!license && !bike) return null;
  return (
    <View style={[styles.row, style]}>
      {license ? (
        <View style={styles.chip}>
          <MaterialCommunityIcons name="card-account-details-outline" size={13} color={colors.primary} />
          <Text style={styles.chipText}>{license}</Text>
        </View>
      ) : null}
      {bike ? (
        <View style={styles.chip}>
          <MaterialCommunityIcons name="motorbike" size={13} color={colors.primary} />
          <Text style={styles.chipText}>{bike}</Text>
        </View>
      ) : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm, flexWrap: 'wrap', justifyContent: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,90,31,0.12)',
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
  },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 12 },
});
