import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewProps,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, gradients, radius, shadow, spacing } from '../theme';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

type ButtonProps = {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger' | 'glass';
  icon?: IconName;
  size?: 'md' | 'sm';
};

// usePressScale gives every tappable a subtle, springy push-down — the kind of
// micro-feedback that makes an app feel alive without being noisy.
function usePressScale(to = 0.96) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = () => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  const onPressOut = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  return { scale, onPressIn, onPressOut };
}

export function Button({ title, onPress, loading, disabled, variant = 'primary', icon, size = 'md' }: ButtonProps) {
  const isDisabled = disabled || loading;
  const { scale, onPressIn, onPressOut } = usePressScale();
  const light = variant === 'ghost' || variant === 'glass';
  const small = size === 'sm';

  const content = loading ? (
    <ActivityIndicator color={light ? colors.primary : '#fff'} />
  ) : (
    <View style={styles.btnRow}>
      {icon ? (
        <MaterialCommunityIcons
          name={icon}
          size={small ? 16 : 18}
          color={light ? colors.text : '#fff'}
          style={{ marginRight: spacing.sm }}
        />
      ) : null}
      <Text numberOfLines={1} style={[styles.buttonText, small && styles.buttonTextSm, light && styles.buttonGhostText]}>
        {title}
      </Text>
    </View>
  );

  const base = [styles.btnBase, small && styles.btnBaseSm];

  return (
    <Animated.View style={{ transform: [{ scale }], opacity: isDisabled ? 0.55 : 1 }}>
      <Pressable onPress={onPress} disabled={isDisabled} onPressIn={onPressIn} onPressOut={onPressOut}>
        {variant === 'ghost' ? (
          <View style={[base, styles.ghost]}>{content}</View>
        ) : variant === 'glass' ? (
          <View style={[base, styles.glass]}>{content}</View>
        ) : (
          <LinearGradient
            colors={variant === 'danger' ? gradients.danger : gradients.primary}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[base, shadow.glow]}
          >
            {content}
          </LinearGradient>
        )}
      </Pressable>
    </Animated.View>
  );
}

export function TextField(props: TextInputProps & { label?: string; icon?: IconName }) {
  const { label, icon, style, onFocus, onBlur, ...rest } = props;
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.inputRow, focused && styles.inputRowFocused]}>
        {icon ? (
          <MaterialCommunityIcons
            name={icon}
            size={20}
            color={focused ? colors.primary : colors.textMuted}
            style={styles.inputIcon}
          />
        ) : null}
        <TextInput
          placeholderTextColor={colors.textFaint}
          style={[styles.input, icon ? styles.inputWithIcon : null, style]}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...rest}
        />
      </View>
    </View>
  );
}

export function Card(props: ViewProps & { glass?: boolean }) {
  const { style, glass, ...rest } = props;
  return <View style={[styles.card, glass && styles.cardGlass, style]} {...rest} />;
}

// TouchCard — a Card that springs on press. Use for tappable list rows so every
// surface in the app shares the same tactile feedback.
export function TouchCard({
  onPress,
  children,
  style,
  glass,
}: {
  onPress: () => void;
  children: React.ReactNode;
  style?: ViewProps['style'];
  glass?: boolean;
}) {
  const { scale, onPressIn, onPressOut } = usePressScale(0.98);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut}>
        <View style={[styles.card, glass && styles.cardGlass, style]}>{children}</View>
      </Pressable>
    </Animated.View>
  );
}

// EmptyState — the consistent "nothing here yet" panel: an ember-tinted icon
// halo, a headline and an optional hint line.
export function EmptyState({ icon, title, hint }: { icon: IconName; title: string; hint?: string }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyHalo}>
        <MaterialCommunityIcons name={icon} size={40} color={colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

// SectionTitle — a consistent ember-accented section header used across screens.
export function SectionTitle({ icon, title, right }: { icon?: IconName; title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <View style={styles.sectionLeft}>
        {icon ? (
          <View style={styles.sectionTick}>
            <MaterialCommunityIcons name={icon} size={15} color={colors.primary} />
          </View>
        ) : null}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

// Chip — a compact pill for tags, metadata and toggles.
export function Chip({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon?: IconName;
  active?: boolean;
  onPress?: () => void;
}) {
  const body = (
    <View style={[styles.chip, active && styles.chipOn]}>
      {icon ? (
        <MaterialCommunityIcons name={icon} size={14} color={active ? colors.primary : colors.textMuted} />
      ) : null}
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} hitSlop={4}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

// Stars renders a 1..5 rating. Pass onRate to make it interactive (tap to set).
export function Stars({
  value,
  count,
  size = 18,
  onRate,
}: {
  value: number;
  count?: number;
  size?: number;
  onRate?: (score: number) => void;
}) {
  return (
    <View style={styles.starsRow}>
      {[1, 2, 3, 4, 5].map((s) => {
        const name = value >= s ? 'star' : value >= s - 0.5 ? 'star-half-full' : 'star-outline';
        const star = <MaterialCommunityIcons name={name} size={size} color={colors.accent} />;
        return onRate ? (
          <Pressable key={s} onPress={() => onRate(s)} hitSlop={6}>
            {star}
          </Pressable>
        ) : (
          <View key={s}>{star}</View>
        );
      })}
      {count !== undefined ? <Text style={styles.starsCount}>({count})</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  btnBase: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnBaseSm: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 1 },
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  glass: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 15,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  buttonTextSm: { fontSize: 13, letterSpacing: 0.5 },
  buttonGhostText: { color: colors.text },
  fieldWrap: { marginBottom: spacing.md },
  label: {
    color: colors.textMuted,
    marginBottom: spacing.xs + 2,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  inputRow: {
    position: 'relative',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  inputRowFocused: { borderColor: colors.primary, backgroundColor: colors.surface },
  inputIcon: { position: 'absolute', left: spacing.md, zIndex: 1 },
  input: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '500',
  },
  inputWithIcon: { paddingLeft: spacing.xl + spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardGlass: { backgroundColor: colors.glass, borderColor: colors.glassBorder },
  emptyState: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl },
  emptyHalo: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(255,106,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: { color: colors.text, fontWeight: '800', fontSize: 16, textAlign: 'center' },
  emptyHint: { color: colors.textMuted, textAlign: 'center', lineHeight: 21, fontSize: 13 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTick: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: 'rgba(255,106,26,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: { color: colors.text, fontWeight: '900', fontSize: 16, letterSpacing: 0.3 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: 'rgba(255,106,26,0.15)' },
  chipText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  chipTextOn: { color: colors.primary },
  starsRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  starsCount: { color: colors.textMuted, fontSize: 12, marginLeft: 4 },
});
