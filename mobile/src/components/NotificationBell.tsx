// Bell + unread badge for screen headers.
//
// It lives in the header rather than as a sixth tab: the tab bar is already
// full, and a notification center is somewhere you visit, not somewhere you
// live. Styling matches RootNavigator's HeaderIconButton and tab badge so the
// two badges read as the same thing in different places.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useNotifications } from '../store/notifications';
import { colors, onAccent, spacing } from '../theme';

export default function NotificationBell({ onPress }: { onPress: () => void }) {
  const { unreadCount } = useNotifications();
  const label = unreadCount > 0 ? `Bildirimler, ${unreadCount} okunmamış` : 'Bildirimler';

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.btn}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons
        name={unreadCount > 0 ? 'bell-badge-outline' : 'bell-outline'}
        size={22}
        color={colors.primary}
      />
      {unreadCount > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.surface,
  },
  // onAccent rather than white: the theme documents white as failing contrast on
  // the ember fill.
  badgeText: { color: onAccent, fontWeight: '900', fontSize: 12 },
});
