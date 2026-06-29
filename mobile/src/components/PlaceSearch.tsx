import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Place, searchPlaces } from '../lib/geocode';
import { colors, radius, shadow, spacing } from '../theme';

/**
 * Reusable address search box with autocomplete suggestions. Drop it on top of a
 * map; when a suggestion is tapped `onPick` fires with the chosen place so the
 * screen can recenter the map and place its marker/waypoint. The query is
 * debounced (~350ms) and biased toward `near` (the rider's position) when given.
 */
export function PlaceSearch({
  onPick,
  near,
  placeholder = 'Adres veya yer ara…',
  style,
}: {
  onPick: (place: Place) => void;
  near?: { lat: number; lon: number };
  placeholder?: string;
  style?: ViewStyle;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Bumped on every keystroke so a slow in-flight response can't overwrite the
  // results of a newer query that resolved first.
  const reqId = useRef(0);
  // Set when a suggestion is picked: the resulting setQuery() must not trigger a
  // fresh search (which would reopen the dropdown over the just-chosen place).
  const suppress = useRef(false);

  useEffect(() => {
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqId.current;
    const timer = setTimeout(async () => {
      const places = await searchPlaces(q, near);
      if (id !== reqId.current) return; // a newer query superseded this one
      setResults(places);
      setOpen(true);
      setLoading(false);
    }, 350);
    return () => clearTimeout(timer);
  }, [query, near]);

  function pick(place: Place) {
    onPick(place);
    suppress.current = true;
    setQuery(place.name);
    setResults([]);
    setOpen(false);
    Keyboard.dismiss();
  }

  function clear() {
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <View style={[styles.wrap, style]}>
      <View style={styles.bar}>
        <MaterialCommunityIcons name="magnify" size={20} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          returnKeyType="search"
        />
        {loading ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : query.length > 0 ? (
          <Pressable onPress={clear} hitSlop={8}>
            <MaterialCommunityIcons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {open && results.length > 0 && (
        <ScrollView
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {results.map((p, i) => (
            <Pressable
              key={`${p.lat},${p.lon},${i}`}
              style={[styles.item, i > 0 && styles.itemBorder]}
              onPress={() => pick(p)}
            >
              <MaterialCommunityIcons name="map-marker" size={18} color={colors.primary} />
              <Text style={styles.itemText} numberOfLines={2}>
                {p.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadow.card,
  },
  input: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 2 },
  list: {
    marginTop: spacing.xs,
    maxHeight: 260,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    ...shadow.card,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  itemBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  itemText: { flex: 1, color: colors.text, fontSize: 14 },
});
