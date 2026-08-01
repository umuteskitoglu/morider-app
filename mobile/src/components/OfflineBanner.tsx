// A thin bar that appears while the phone has no connection.
//
// Without it, offline screens are indistinguishable from broken ones: a garage
// showing three bikes that were saved yesterday looks exactly like a garage
// that just loaded, and a stale one is worth knowing about before you trust the
// inspection date on it.
//
// Deliberately slim and non-interactive — it sits over the header rather than
// pushing the layout around, and never intercepts a tap, because it can appear
// mid-ride while the rider is aiming for a button underneath it.
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useConnectivity } from '../store/connectivity';
import { colors, spacing, type } from '../theme';

export default function OfflineBanner() {
  const { online } = useConnectivity();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: online ? 0 : 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [online, anim]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-60, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { paddingTop: insets.top, transform: [{ translateY }], opacity: anim }]}
    >
      <View style={styles.row}>
        <MaterialCommunityIcons name="wifi-off" size={14} color={colors.bg} />
        <Text style={styles.text}>Çevrimdışısın · kayıtlı içerik gösteriliyor</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.accent,
    zIndex: 50,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
  },
  text: { ...type.micro, color: colors.bg },
});
