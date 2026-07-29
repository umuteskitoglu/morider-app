import React, { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { radius, shadow, spacing, type } from '../theme';

/**
 * The official four-colour Google "G".
 *
 * Drawn as SVG rather than a bundled PNG so it stays crisp at every density and
 * adds no asset. Google's branding guidelines require the mark be shown in its
 * original colours on a white or dark surface, never recoloured or redrawn — a
 * monochrome icon-font glyph would not satisfy that.
 */
function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityRole="image">
      <Path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <Path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <Path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <Path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </Svg>
  );
}

type Props = {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** Wording differs between the login and sign-up screens. */
  title?: string;
};

/**
 * Google sign-in button.
 *
 * Deliberately white rather than styled like the app's ember CTA: Google's
 * guidelines require one of their prescribed treatments, and the contrast also
 * keeps it visually secondary to the primary action on each screen.
 */
export function GoogleSignInButton({
  onPress,
  loading,
  disabled,
  title = 'Google ile devam et',
}: Props) {
  const isDisabled = disabled || loading;
  const scale = useRef(new Animated.Value(1)).current;

  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 6 }).start();

  return (
    <Animated.View style={{ transform: [{ scale }], opacity: isDisabled ? 0.55 : 1 }}>
      <Pressable
        onPress={onPress}
        disabled={isDisabled}
        onPressIn={() => spring(0.96)}
        onPressOut={() => spring(1)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
        style={styles.button}
      >
        {loading ? (
          <ActivityIndicator color="#1F1F1F" />
        ) : (
          <View style={styles.row}>
            <GoogleG />
            <Text numberOfLines={1} style={styles.label}>
              {title}
            </Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** "veya" rule used to separate the Google button from the email form. */
export function OrDivider({ label = 'veya' }: { label?: string }) {
  return (
    <View style={styles.dividerRow}>
      <View style={styles.dividerLine} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 52, // matches the primary Button so the stack reads as one column
    borderRadius: radius.lg,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    ...shadow.card,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  label: {
    // Google's own spec: near-black on white, never pure #000.
    color: '#1F1F1F',
    marginLeft: spacing.sm + 2,
    ...type.label,
    fontSize: 15,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  dividerLabel: {
    color: '#8A929E',
    marginHorizontal: spacing.md,
    ...type.micro,
  },
});
