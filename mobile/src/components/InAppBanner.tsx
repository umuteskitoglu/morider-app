// In-app notification banner.
//
// A push that arrives while the app is open shows nothing: the OS suppresses its
// own banner, and there is no tap for the handlers in lib/push to react to. So
// the app draws its own.
//
// Deliberately not bridged into expo-notifications: that would need a plugin
// entry in app.json, it depends on setNotificationHandler which today only runs
// as a side effect of the event-reminder module (so it may never have run when a
// push lands), and on iOS it renders a system banner over your own app, which
// reads as a bug.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openNotification } from '../lib/notificationRoute';
import { colors, gradients, radius, spacing, type } from '../theme';

const VISIBLE_MS = 4000;

type BannerPayload = { title: string; body: string; data: Record<string, unknown> };

// Module-level pub/sub so a non-React caller (the FCM message handler) can raise
// a banner. Same shape as components/TourTarget's node registry.
let subscriber: ((b: BannerPayload) => void) | null = null;

export function showBanner(title: string, body: string, data: Record<string, unknown>): void {
  if (!title && !body) return;
  subscriber?.({ title, body, data });
}

export default function InAppBanner() {
  const insets = useSafeAreaInsets();
  const [banner, setBanner] = useState<BannerPayload | null>(null);
  const slide = useRef(new Animated.Value(-160)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    Animated.timing(slide, { toValue: -160, duration: 180, useNativeDriver: true }).start(() =>
      setBanner(null),
    );
  }, [slide]);

  useEffect(() => {
    subscriber = (b) => {
      setBanner(b);
      slide.setValue(-160);
      Animated.spring(slide, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 6 }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, VISIBLE_MS);
    };
    return () => {
      subscriber = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [slide, hide]);

  // Swiping a banner up to dismiss it is reflex; without it the only way out is
  // to wait or to open something you did not want.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy < -6,
      onPanResponderMove: (_, g) => {
        if (g.dy < 0) slide.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy < -30) hide();
        else Animated.spring(slide, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  if (!banner) return null;

  return (
    <Animated.View
      style={[styles.wrap, { top: insets.top + spacing.xs, transform: [{ translateY: slide }] }]}
      {...pan.panHandlers}
    >
      <Pressable
        onPress={() => {
          hide();
          openNotification(banner.data);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${banner.title}. ${banner.body}`}
      >
        <LinearGradient colors={gradients.glass} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.card}>
          <View style={styles.icon}>
            <MaterialCommunityIcons name="bell" size={18} color={colors.primary} />
          </View>
          <View style={styles.flex}>
            {banner.title ? (
              <Text style={styles.title} numberOfLines={1}>
                {banner.title}
              </Text>
            ) : null}
            {banner.body ? (
              <Text style={styles.body} numberOfLines={2}>
                {banner.body}
              </Text>
            ) : null}
          </View>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.md, right: spacing.md, zIndex: 100 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,106,26,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  title: { ...type.caption, color: colors.text },
  body: { ...type.body, color: colors.textMuted, marginTop: 1 },
});
