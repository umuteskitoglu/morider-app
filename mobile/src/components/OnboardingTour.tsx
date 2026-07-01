import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  ListRenderItemInfo,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from './ui';
import { colors, gradients, radius, spacing } from '../theme';

// Bump the version when the tour content changes enough that returning riders
// should see it again; each version is a distinct "seen" flag.
const SEEN_KEY = 'morider.onboarding.v1';

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

type Slide = {
  icon: IconName;
  title: string;
  body: string;
};

// One slide per home tab, plus a warm welcome — a first-time rider gets the map
// of the app before the map of the road.
const SLIDES: Slide[] = [
  {
    icon: 'motorbike',
    title: "Morider'a hoş geldin",
    body: 'Sürüşlerini kaydet, rotaları keşfet ve diğer motorcularla buluş. Uygulamayı 30 saniyede tanıyalım.',
  },
  {
    icon: 'map-marker-path',
    title: 'Sürüş',
    body: 'Haritadan tek başına sür ya da bir kod paylaşıp arkadaşlarınla grup sürüşü başlat. Hızın, mesafen ve rotan canlı olarak kaydedilir.',
  },
  {
    icon: 'image-multiple',
    title: 'Akış',
    body: 'Sürüşlerini ve fotoğraflarını paylaş, diğer motorcuları takip et. Topluluğun neler yaptığını buradan görürsün.',
  },
  {
    icon: 'calendar-clock',
    title: 'Etkinlik',
    body: 'Buluşmalar ve grup sürüşleri düzenle ya da mevcut etkinliklere katıl. Sohbet ve konum tek yerde.',
  },
  {
    icon: 'account',
    title: 'Profil',
    body: 'Garajın, rotaların, kapışmaların ve rozetlerin burada. Seviye atla, sezon liderliğinde yerini al.',
  },
];

// OnboardingTour is a one-time, full-screen welcome carousel shown to a signed-in
// rider who hasn't seen it yet. It self-manages its "seen" flag in AsyncStorage;
// mount it once inside the authenticated flow and it decides whether to appear.
export default function OnboardingTour() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<Slide>>(null);
  const scrollX = useRef(new Animated.Value(0)).current;

  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(0);
  const fade = useRef(new Animated.Value(0)).current;

  const open = useCallback(() => {
    setIndex(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    scrollX.setValue(0);
    setVisible(true);
    Animated.timing(fade, { toValue: 1, duration: 320, useNativeDriver: true }).start();
  }, [fade, scrollX]);

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
  }, [open]);

  const isLast = index === SLIDES.length - 1;

  function finish() {
    // Persist first (best effort), then fade out — the rider never sees it again.
    AsyncStorage.setItem(SEEN_KEY, '1').catch(() => {});
    Animated.timing(fade, { toValue: 0, duration: 260, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setVisible(false);
    });
  }

  function next() {
    if (isLast) {
      finish();
      return;
    }
    listRef.current?.scrollToIndex({ index: index + 1, animated: true });
  }

  const onMomentumEnd = (e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index) setIndex(i);
  };

  if (!visible) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      <LinearGradient colors={gradients.hero} style={StyleSheet.absoluteFill} />

      {/* Skip — always available so the tour never feels like a wall. */}
      <Pressable onPress={finish} hitSlop={10} style={[styles.skip, { top: insets.top + spacing.sm }]}>
        <Text style={styles.skipText}>Atla</Text>
      </Pressable>

      <Animated.FlatList
        ref={listRef}
        data={SLIDES}
        keyExtractor={(s) => s.title}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        onMomentumScrollEnd={onMomentumEnd}
        renderItem={({ item }: ListRenderItemInfo<Slide>) => (
          <View style={[styles.slide, { width }]}>
            <View style={styles.halo}>
              <MaterialCommunityIcons name={item.icon} size={68} color={colors.primary} />
            </View>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
          </View>
        )}
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        {/* Progress dots: the active dot widens into an ember pill. */}
        <View style={styles.dots}>
          {SLIDES.map((_, i) => {
            const inputRange = [(i - 1) * width, i * width, (i + 1) * width];
            const dotWidth = scrollX.interpolate({ inputRange, outputRange: [8, 22, 8], extrapolate: 'clamp' });
            const opacity = scrollX.interpolate({ inputRange, outputRange: [0.3, 1, 0.3], extrapolate: 'clamp' });
            return <Animated.View key={i} style={[styles.dot, { width: dotWidth, opacity }]} />;
          })}
        </View>

        <Button title={isLast ? 'Hadi başlayalım' : 'İleri'} icon={isLast ? 'flag-checkered' : undefined} onPress={next} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 1000, alignItems: 'stretch', justifyContent: 'center' },
  skip: { position: 'absolute', right: spacing.lg, zIndex: 2, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  skipText: { color: colors.textMuted, fontWeight: '800', fontSize: 14, letterSpacing: 0.5 },
  slide: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  halo: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(255,106,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', letterSpacing: 0.4, textAlign: 'center', marginBottom: spacing.md },
  body: { color: colors.textMuted, fontSize: 15.5, lineHeight: 24, textAlign: 'center', maxWidth: 340 },
  footer: { paddingHorizontal: spacing.xl, gap: spacing.lg },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 10 },
  dot: { height: 8, borderRadius: radius.pill, backgroundColor: colors.primary },
});
