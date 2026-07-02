import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { blockUser, unblockUser } from '../lib/block';
import { useBlockedUsers } from '../store/blockedUsers';
import { errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = {
  userId: number;
  name: string;
  /** Called after a successful block/unblock so the caller can clear local follow state etc. */
  onChange?: (blocking: boolean) => void;
};

/**
 * BlockButton toggles a block on /api/blocks/:userId. Always confirms before
 * blocking (destructive: it also tears down the follow relationship).
 */
export default function BlockButton({ userId, name, onChange }: Props) {
  const { isBlocked, refresh } = useBlockedUsers();
  const blocking = isBlocked(userId);
  const [busy, setBusy] = useState(false);

  function confirmBlock() {
    Alert.alert(
      'Kullanıcıyı engelle',
      `${name} adlı kullanıcıyı engellemek istiyor musun? Artık sana mesaj gönderemez ve seni takip edemez.`,
      [
        { text: 'Vazgeç', style: 'cancel' },
        { text: 'Engelle', style: 'destructive', onPress: doBlock },
      ],
    );
  }

  async function doBlock() {
    setBusy(true);
    try {
      await blockUser(userId);
      await refresh();
      onChange?.(true);
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doUnblock() {
    setBusy(true);
    try {
      await unblockUser(userId);
      await refresh();
      onChange?.(false);
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Pressable onPress={blocking ? doUnblock : confirmBlock} disabled={busy} style={styles.pill} hitSlop={8}>
      {busy ? (
        <ActivityIndicator size="small" color={colors.danger} />
      ) : (
        <>
          <MaterialCommunityIcons name={blocking ? 'account-cancel' : 'cancel'} size={14} color={colors.danger} />
          <Text style={styles.text}>{blocking ? 'Engeli kaldır' : 'Engelle'}</Text>
        </>
      )}
    </Pressable>
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
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  text: { fontWeight: '800', fontSize: 12, color: colors.danger },
});
