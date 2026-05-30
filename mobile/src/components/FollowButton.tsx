import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button } from './ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = {
  userId: number;
  following: boolean;
  onChange?: (following: boolean) => void;
  /** Compact pill variant for dense lists (e.g. Explore cards). */
  compact?: boolean;
};

/**
 * FollowButton toggles a one-directional follow on /api/follows/:userId.
 * Optimistic: flips immediately, reverts on error.
 */
export default function FollowButton({ userId, following, onChange, compact }: Props) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    const next = !following;
    setBusy(true);
    onChange?.(next); // optimistic
    try {
      if (next) {
        await api.put(`/api/follows/${userId}`);
      } else {
        await api.delete(`/api/follows/${userId}`);
      }
    } catch (err) {
      onChange?.(following); // revert
      Alert.alert('Hata', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <Pressable
        onPress={toggle}
        disabled={busy}
        hitSlop={8}
        style={[styles.pill, following ? styles.pillGhost : styles.pillPrimary]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={following ? colors.text : '#fff'} />
        ) : (
          <>
            <MaterialCommunityIcons
              name={following ? 'check' : 'account-plus'}
              size={14}
              color={following ? colors.text : '#fff'}
            />
            <Text style={[styles.pillText, following ? styles.pillTextGhost : styles.pillTextPrimary]}>
              {following ? 'Takip ediliyor' : 'Takip et'}
            </Text>
          </>
        )}
      </Pressable>
    );
  }

  return (
    <Button
      title={following ? 'Takip ediliyor' : 'Takip et'}
      icon={following ? 'check' : 'account-plus'}
      variant={following ? 'ghost' : 'primary'}
      loading={busy}
      onPress={toggle}
    />
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    minHeight: 30,
    justifyContent: 'center',
  },
  pillPrimary: { backgroundColor: colors.primary },
  pillGhost: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  pillText: { fontWeight: '800', fontSize: 12 },
  pillTextPrimary: { color: '#fff' },
  pillTextGhost: { color: colors.text },
});
