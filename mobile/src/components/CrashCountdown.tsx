import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../theme';

const COUNTDOWN_SECONDS = 30;

/**
 * Full-screen emergency countdown shown after a suspected crash. Vibrates the
 * whole time; a huge cancel button dismisses it ("I'm fine"). If the countdown
 * reaches zero, `onExpire` fires (send SOS / open SMS) — the rider may be
 * unable to interact, so cancellation must be the only thing requiring input.
 */
export function CrashCountdown({
  visible,
  onCancel,
  onExpire,
}: {
  visible: boolean;
  onCancel: () => void;
  onExpire: () => void;
}) {
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    if (!visible) return;
    setLeft(COUNTDOWN_SECONDS);
    Vibration.vibrate([500, 500], true);
    const iv = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          clearInterval(iv);
          expire.current();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      clearInterval(iv);
      Vibration.cancel();
    };
  }, [visible]);

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <MaterialCommunityIcons name="alert-octagon" size={56} color={colors.danger} />
        <Text style={styles.title}>Kaza algılandı!</Text>
        <Text style={styles.sub}>
          İyiysen iptal et. {'\n'}Süre dolunca acil durum bildirimi gönderilecek.
        </Text>
        <Text style={styles.count}>{left}</Text>
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <MaterialCommunityIcons name="check-circle" size={28} color="#fff" />
          <Text style={styles.cancelText}>İYİYİM, İPTAL ET</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10,14,22,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { color: colors.danger, fontSize: 28, fontWeight: '900' },
  sub: { color: colors.text, textAlign: 'center', fontSize: 16, lineHeight: 24 },
  count: { color: '#fff', fontSize: 96, fontWeight: '900', fontVariant: ['tabular-nums'] },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.success,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    alignSelf: 'stretch',
  },
  cancelText: { color: '#fff', fontSize: 20, fontWeight: '900', letterSpacing: 1 },
});
