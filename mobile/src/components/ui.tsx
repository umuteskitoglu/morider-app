import React from 'react';
import {
  ActivityIndicator,
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
  variant?: 'primary' | 'ghost' | 'danger';
  icon?: IconName;
};

export function Button({ title, onPress, loading, disabled, variant = 'primary', icon }: ButtonProps) {
  const isDisabled = disabled || loading;

  const content = loading ? (
    <ActivityIndicator color={variant === 'ghost' ? colors.primary : '#fff'} />
  ) : (
    <View style={styles.btnRow}>
      {icon ? (
        <MaterialCommunityIcons
          name={icon}
          size={18}
          color={variant === 'ghost' ? colors.text : '#fff'}
          style={{ marginRight: spacing.sm }}
        />
      ) : null}
      <Text numberOfLines={1} style={[styles.buttonText, variant === 'ghost' && styles.buttonGhostText]}>{title}</Text>
    </View>
  );

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [(pressed || isDisabled) && styles.pressed]}
    >
      {variant === 'ghost' ? (
        <View style={[styles.btnBase, styles.ghost]}>{content}</View>
      ) : (
        <LinearGradient
          colors={variant === 'danger' ? gradients.danger : gradients.primary}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.btnBase, shadow.glow]}
        >
          {content}
        </LinearGradient>
      )}
    </Pressable>
  );
}

export function TextField(props: TextInputProps & { label?: string; icon?: IconName }) {
  const { label, icon, style, ...rest } = props;
  return (
    <View style={styles.fieldWrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.inputRow}>
        {icon ? <MaterialCommunityIcons name={icon} size={20} color={colors.textMuted} style={styles.inputIcon} /> : null}
        <TextInput
          placeholderTextColor={colors.textMuted}
          style={[styles.input, icon ? styles.inputWithIcon : null, style]}
          {...rest}
        />
      </View>
    </View>
  );
}

export function Card(props: ViewProps) {
  const { style, ...rest } = props;
  return <View style={[styles.card, style]} {...rest} />;
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
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 1 },
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.99 }] },
  buttonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  buttonGhostText: { color: colors.text },
  fieldWrap: { marginBottom: spacing.md },
  label: {
    color: colors.textMuted,
    marginBottom: spacing.xs,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  inputRow: { position: 'relative', justifyContent: 'center' },
  inputIcon: { position: 'absolute', left: spacing.md, zIndex: 1 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 16,
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
  starsRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  starsCount: { color: colors.textMuted, fontSize: 12, marginLeft: 4 },
});
