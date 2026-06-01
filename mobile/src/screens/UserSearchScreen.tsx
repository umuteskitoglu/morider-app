import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { FeedStackParams } from '../navigation/RootNavigator';
import { Card, TextField } from '../components/ui';
import FollowButton from '../components/FollowButton';
import { api, apiBaseURL } from '../api/client';
import { colors, spacing } from '../theme';

type Result = { id: number; name: string; avatar_url: string; following: boolean };
type Props = NativeStackScreenProps<FeedStackParams, 'UserSearch'>;

export default function UserSearchScreen({ navigation }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  // ids the caller currently follows — drives each row's button state.
  const [followedIds, setFollowedIds] = useState<Set<number>>(new Set());
  // Guards against a slow request overwriting a newer one's results.
  const reqId = useRef(0);

  const search = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    try {
      const { data } = await api.get('/api/users/search', { params: { q: trimmed } });
      if (id !== reqId.current) return; // a newer search superseded this one
      const users: Result[] = data.users ?? [];
      setResults(users);
      setFollowedIds(new Set(users.filter((u) => u.following).map((u) => u.id)));
    } catch {
      if (id === reqId.current) setResults([]);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // Debounce queries so we don't fire a request on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => search(q), 300);
    return () => clearTimeout(t);
  }, [q, search]);

  function onToggle(id: number, isFollowing: boolean) {
    setFollowedIds((prev) => {
      const next = new Set(prev);
      if (isFollowing) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const empty = q.trim().length < 2
    ? 'En az 2 harf yazarak kullanıcı ara.'
    : loading
      ? null
      : 'Eşleşen kullanıcı bulunamadı.';

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <TextField
          icon="magnify"
          placeholder="İsme göre ara"
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={results}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          empty ? (
            <Card>
              <Text style={styles.muted}>{empty}</Text>
            </Card>
          ) : loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('UserProfile', { userId: item.id, name: item.name })}>
            <Card style={styles.row}>
              <Avatar name={item.name} url={item.avatar_url} />
              <View style={styles.info}>
                <Text style={styles.name}>{item.name}</Text>
              </View>
              <FollowButton
                userId={item.id}
                following={followedIds.has(item.id)}
                onChange={(f) => onToggle(item.id, f)}
                compact
              />
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

function Avatar({ name, url }: { name: string; url: string }) {
  if (url) {
    return <Image source={{ uri: `${apiBaseURL()}${url}` }} style={styles.avatar} />;
  }
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  spinner: { marginTop: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  info: { flex: 1 },
  name: { color: colors.text, fontWeight: '800' },
  muted: { color: colors.textMuted },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '900' },
});
