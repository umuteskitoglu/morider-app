import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from './ui';
import { measureTourTarget, TargetRect } from './TourTarget';
import { navigateToTab } from '../navigation/navigationRef';
import { colors, radius, shadow, spacing } from '../theme';

// v2: the tour became an in-app spotlight tutorial (it used to be a full-screen
// carousel), so returning riders see it once more. Bump again whenever the
// content changes enough that everyone should re-watch.
const SEEN_KEY = 'morider.onboarding.v2';

// The mounted tour registers a "show me" callback here so any screen (e.g. a
// "replay the tour" row in Profile) can bring it back on demand.
let showTour: (() => void) | null = null;

// replayOnboarding re-opens the welcome tour from anywhere in the app. Safe to
// call even if the tour isn't mounted — it just clears the seen flag so the tour
// appears on the next launch.
export function replayOnboarding() {
  AsyncStorage.removeItem(SEEN_KEY).catch(() => {});
  showTour?.();
}

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

type Step = {
  icon: IconName;
  title: string;
  body: string;
  // TourTarget id to spotlight; omitted = centered card over a full scrim.
  target?: string;
  // Tab to switch to when the step opens, so the rider sees the real screen
  // behind the scrim while its element is highlighted.
  tab?: string;
};

// The tour walks the real UI: first the two ride actions on the map screen,
// then each remaining tab cell — switching to that tab so the actual screen
// shows behind the spotlight.
const STEPS: Step[] = [
  {
    icon: 'motorbike',
    title: "Morider'a hoş geldin",
    body: 'Uygulamayı gerçek ekranların üzerinde adım adım tanıyalım. Devam etmek için ekrana dokun.',
    tab: 'Ride',
  },
  {
    icon: 'record-circle',
    title: 'Sürüşü başlat',
    body: 'Tek dokunuşla kayıt başlar: hızın, mesafen ve rotan canlı kaydedilir. Haritadan bir hedef seçersen bu buton navigasyona dönüşür.',
    target: 'ride.start',
    tab: 'Ride',
  },
  {
    icon: 'account-group',
    title: 'Grup sürüşü',
    body: 'Bir kod oluşturup arkadaşlarınla paylaş; sürüş boyunca birbirinizi haritada canlı görürsünüz.',
    target: 'ride.group',
    tab: 'Ride',
  },
  {
    icon: 'image-multiple',
    title: 'Akış',
    body: 'Sürüşlerini ve fotoğraflarını paylaş, diğer motorcuları takip et. Topluluğun neler yaptığını buradan görürsün.',
    target: 'tab.Feed',
    tab: 'Feed',
  },
  {
    icon: 'calendar-clock',
    title: 'Etkinlik',
    body: 'Buluşmalar ve grup sürüşleri düzenle ya da mevcut etkinliklere katıl. Sohbet ve konum tek yerde.',
    target: 'tab.Events',
    tab: 'Events',
  },
  {
    icon: 'chat',
    title: 'Sohbet',
    body: 'Topluluk sohbetine katıl ya da motorculara birebir mesaj gönder.',
    target: 'tab.Chat',
    tab: 'Chat',
  },
  {
    icon: 'account',
    title: 'Profil',
    body: 'Garajın, rotaların, kapışmaların ve rozetlerin burada. Seviye atla, sezon liderliğinde yerini al.',
    target: 'tab.Profile',
    tab: 'Profile',
  },
];

// The scrim is one huge border around an animated content box: the box is the
// spotlight hole, the border is the dark overlay. Moving/resizing the box
// slides the hole from one element to the next in a single Animated.View.
const SCRIM_BORDER = 4000;
const HOLE_PAD = 6;
const HOLE_RADIUS = 14;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// OnboardingTour is a one-time, step-by-step spotlight tutorial shown to a
// signed-in rider who hasn't seen it yet. It dims the app, highlights real UI
// elements one at a time and switches tabs as it goes. Self-manages its "seen"
// flag in AsyncStorage; mount it once inside the authenticated flow.
export default function OnboardingTour() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<{ index: number; rect: TargetRect | null }>({ index: 0, rect: null });

  const fade = useRef(new Animated.Value(0)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;
  // Hole box in window coordinates (already includes HOLE_PAD).
  const hole = useRef({
    x: new Animated.Value(0),
    y: new Animated.Value(0),
    w: new Animated.Value(0),
    h: new Animated.Value(0),
  }).current;

  // Guards async step transitions: bumping it invalidates in-flight measures
  // (fast taps, skip mid-measure, replay while a step is settling).
  const seq = useRef(0);

  const collapseHole = useCallback(() => {
    hole.x.setValue(width / 2);
    hole.y.setValue(height / 2);
    hole.w.setValue(0);
    hole.h.setValue(0);
  }, [hole, width, height]);

  const animateHole = useCallback(
    (rect: TargetRect | null) => {
      // Layout props can't ride the native driver, and the tour is short-lived,
      // so everything here animates on the JS driver.
      const to = rect
        ? {
            x: rect.x - HOLE_PAD,
            y: rect.y - HOLE_PAD,
            w: rect.width + HOLE_PAD * 2,
            h: rect.height + HOLE_PAD * 2,
          }
        : { x: width / 2, y: height / 2, w: 0, h: 0 };
      Animated.parallel([
        Animated.timing(hole.x, { toValue: to.x, duration: 280, useNativeDriver: false }),
        Animated.timing(hole.y, { toValue: to.y, duration: 280, useNativeDriver: false }),
        Animated.timing(hole.w, { toValue: to.w, duration: 280, useNativeDriver: false }),
        Animated.timing(hole.h, { toValue: to.h, duration: 280, useNativeDriver: false }),
        Animated.timing(ringOpacity, { toValue: rect ? 1 : 0, duration: 280, useNativeDriver: false }),
      ]).start();
    },
    [hole, ringOpacity, width, height]
  );

  const finish = useCallback(
    (completed: boolean) => {
      seq.current++;
      // Persist first (best effort), then fade out.
      AsyncStorage.setItem(SEEN_KEY, '1').catch(() => {});
      // Completing the tour lands the rider on the Ride tab, ready to go; a
      // skip leaves them wherever they are.
      if (completed) navigateToTab('Ride');
      Animated.timing(fade, { toValue: 0, duration: 240, useNativeDriver: false }).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    },
    [fade]
  );

  const goToStep = useCallback(
    async (index: number) => {
      const my = ++seq.current;
      if (index >= STEPS.length) {
        finish(true);
        return;
      }
      const step = STEPS[index];
      if (step.tab) navigateToTab(step.tab);

      let rect: TargetRect | null = null;
      if (step.target) {
        // The target may still be mounting (tab switch, map screen settling) —
        // retry briefly, and skip the step if it never shows up (e.g. a ride
        // is already recording, so the start button isn't on screen).
        for (let attempt = 0; attempt < 12 && !rect; attempt++) {
          rect = await measureTourTarget(step.target);
          if (seq.current !== my) return;
          if (!rect) await delay(90);
        }
        if (seq.current !== my) return;
        if (!rect) {
          goToStep(index + 1);
          return;
        }
      }
      setCurrent({ index, rect });
      animateHole(rect);
    },
    [animateHole, finish]
  );

  const open = useCallback(() => {
    seq.current++;
    setCurrent({ index: 0, rect: null });
    collapseHole();
    ringOpacity.setValue(0);
    setVisible(true);
    Animated.timing(fade, { toValue: 1, duration: 280, useNativeDriver: false }).start();
    goToStep(0);
  }, [collapseHole, fade, goToStep, ringOpacity]);

  // Decide once on mount whether this rider still needs the tour, and expose the
  // "show me" hook so replayOnboarding() can re-open it later.
  useEffect(() => {
    showTour = open;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(SEEN_KEY);
        if (!seen) open();
      } catch {
        // If storage is unreadable, skip the tour rather than block the app.
      }
    })();
    return () => {
      if (showTour === open) showTour = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  const step = STEPS[current.index];
  const rect = current.rect;
  const isLast = current.index === STEPS.length - 1;

  const next = () => {
    if (isLast) finish(true);
    else goToStep(current.index + 1);
  };

  // Card goes on whichever side of the spotlight has more room; with no target
  // it floats centered over the full scrim.
  const cardPos = rect
    ? rect.y + rect.height / 2 > height / 2
      ? { bottom: height - rect.y + HOLE_PAD + spacing.md }
      : { top: rect.y + rect.height + HOLE_PAD + spacing.md }
    : { top: 0, bottom: 0, justifyContent: 'center' as const };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      {/* Tapping anywhere advances — the scrim doubles as the "next" surface
          and keeps the app underneath untouchable during the tour. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={next}>
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: Animated.subtract(hole.x, SCRIM_BORDER),
            top: Animated.subtract(hole.y, SCRIM_BORDER),
            width: Animated.add(hole.w, SCRIM_BORDER * 2),
            height: Animated.add(hole.h, SCRIM_BORDER * 2),
            borderWidth: SCRIM_BORDER,
            borderColor: 'rgba(5,7,12,0.84)',
            borderRadius: SCRIM_BORDER + HOLE_RADIUS,
          }}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.ring, { left: hole.x, top: hole.y, width: hole.w, height: hole.h, opacity: ringOpacity }]}
        />
      </Pressable>

      {/* Skip — always available so the tour never feels like a wall. */}
      <Pressable onPress={() => finish(false)} hitSlop={10} style={[styles.skip, { top: insets.top + spacing.sm }]}>
        <Text style={styles.skipText}>Atla</Text>
      </Pressable>

      <View style={[styles.cardWrap, cardPos]} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <View style={styles.iconBubble}>
              <MaterialCommunityIcons name={step.icon} size={22} color={colors.primary} />
            </View>
            <Text style={styles.title}>{step.title}</Text>
          </View>
          <Text style={styles.body}>{step.body}</Text>
          <View style={styles.dots}>
            {STEPS.map((_, i) => (
              <View key={i} style={[styles.dot, i === current.index && styles.dotOn]} />
            ))}
          </View>
          <Button title={isLast ? 'Hadi başlayalım' : 'İleri'} icon={isLast ? 'flag-checkered' : undefined} onPress={next} />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 1000 },
  ring: {
    position: 'absolute',
    borderRadius: HOLE_RADIUS,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  skip: { position: 'absolute', right: spacing.lg, zIndex: 2, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  skipText: { color: colors.textMuted, fontWeight: '800', fontSize: 14, letterSpacing: 0.5 },
  cardWrap: { position: 'absolute', left: spacing.lg, right: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,106,26,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, color: colors.text, fontSize: 19, fontWeight: '900', letterSpacing: 0.3 },
  body: { color: colors.textMuted, fontSize: 14.5, lineHeight: 22 },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.primary, opacity: 0.3 },
  dotOn: { width: 20, opacity: 1 },
});
