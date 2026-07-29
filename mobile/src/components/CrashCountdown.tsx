import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';

import { configureAudioSession } from '../lib/audio';
import { colors, radius, spacing } from '../theme';

const COUNTDOWN_SECONDS = 30;
// Spoken checkpoints. A silent vibrating phone in a tank bag reaches nobody;
// speech carries to a helmet intercom, which is where the rider actually is.
const SPOKEN_AT = new Set([20, 10, 5, 4, 3, 2, 1]);

/**
 * Full-screen emergency countdown shown after a suspected crash.
 *
 * Two outcomes need to be one tap away, not one:
 *  - "I'm fine" cancels it (the common case: a dropped phone, a kerb).
 *  - "I'm hurt" must not force a conscious, injured rider to wait out 30
 *    seconds before anyone is told.
 *
 * If nobody touches anything, the countdown expires and `onExpire` raises the
 * alert anyway — that path is for a rider who cannot interact at all, so
 * cancellation is the only thing that requires input.
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

    // playsInSilentMode: a phone on silent is the normal state on a bike, and
    // it must not be the reason the alarm goes unheard.
    configureAudioSession();
    const say = (text: string) => {
      Speech.stop();
      Speech.speak(text, { language: 'tr-TR', rate: 1.0 });
    };
    say('Kaza algılandı. İyiysen iptal et.');

    let remaining = COUNTDOWN_SECONDS;
    const iv = setInterval(() => {
      remaining -= 1;
      setLeft(remaining);
      if (SPOKEN_AT.has(remaining)) say(String(remaining));
      // Fire the side effect from the interval body — not from a setState
      // updater, which React can call twice (Strict Mode) and would double-send.
      if (remaining <= 0) {
        clearInterval(iv);
        say('Yardım çağrılıyor.');
        expire.current();
      }
    }, 1000);
    return () => {
      clearInterval(iv);
      Vibration.cancel();
      Speech.stop();
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
        <Text
          style={styles.count}
          accessibilityLiveRegion="assertive"
          accessibilityLabel={`${left} saniye kaldı`}
        >
          {left}
        </Text>

        {/* An injured but conscious rider shouldn't have to wait out the timer. */}
        <Pressable
          style={styles.nowBtn}
          onPress={() => expire.current()}
          accessibilityRole="button"
          accessibilityLabel="Şimdi yardım çağır"
        >
          <MaterialCommunityIcons name="alert-octagram" size={26} color="#fff" />
          <Text style={styles.nowText}>ŞİMDİ YARDIM ÇAĞIR</Text>
        </Pressable>

        <Pressable
          style={styles.cancelBtn}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="İyiyim, alarmı iptal et"
        >
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
  nowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.danger,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignSelf: 'stretch',
  },
  nowText: { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 0.5 },
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
