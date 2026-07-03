import React, { useCallback, useLayoutEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EmptyState, TextField } from '../components/ui';
import { ChatStackParams } from '../navigation/RootNavigator';
import { Community, fetchCommunities } from '../lib/communities';
import { colors, gradients, radius, spacing } from '../theme';

// CommunitiesScreen lists the rider's own clubs first, then discoverable ones,
// with a name search on top (ConversationsScreen's sectioned-list pattern).
export default function CommunitiesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ChatStackParams>>();
  const [items, setItems] = useState<Community[]>([]);
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate('CommunityCreate')} hitSlop={8} style={styles.headerBtn}>
          <MaterialCommunityIcons name="plus" size={24} color={colors.primary} />
        </Pressable>
      ),
    });
  }, [navigation]);

  const load = useCallback(async (query: string) => {
    try {
      setItems(await fetchCommunities(query ? { q: query } : undefined));
    } catch {
      // ignore; empty state renders
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(q);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(q);
    setRefreshing(false);
  }, [load, q]);

  const mine = items.filter((c) => c.my_status !== '');
  const discover = items.filter((c) => c.my_status === '');

  type ListRow = { type: 'section'; title: string } | { type: 'item'; community: Community };
  const rows: ListRow[] = [];
  if (mine.length > 0) {
    rows.push({ type: 'section', title: 'Topluluklarım' });
    rows.push(...mine.map((c) => ({ type: 'item' as const, community: c })));
  }
  if (discover.length > 0) {
    rows.push({ type: 'section', title: 'Keşfet' });
    rows.push(...discover.map((c) => ({ type: 'item' as const, community: c })));
  }

  return (
    <View style={styles.container}>
      <View style={styles.search}>
        <TextField
          icon="magnify"
          placeholder="Topluluk ara..."
          value={q}
          onChangeText={(t) => {
            setQ(t);
            load(t);
          }}
          autoCapitalize="none"
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row, i) => (row.type === 'section' ? `s-${row.title}` : `c-${row.community.id}-${i}`)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListEmptyComponent={
          <EmptyState
            icon="account-group-outline"
            title="Henüz topluluk yok"
            hint="Sağ üstteki + ile ilk topluluğu sen kur; kulübünü bir araya getir!"
          />
        }
        renderItem={({ item }) =>
          item.type === 'section' ? (
            <Text style={styles.sectionTitle}>{item.title}</Text>
          ) : (
            <CommunityRow
              community={item.community}
              onPress={() =>
                navigation.navigate('CommunityDetail', { id: item.community.id, name: item.community.name })
              }
            />
          )
        }
      />
    </View>
  );
}

function CommunityRow({ community, onPress }: { community: Community; onPress: () => void }) {
  const closed = community.privacy === 'closed';
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      <LinearGradient colors={gradients.primary} style={styles.avatar}>
        <Text style={styles.avatarText}>{community.name.charAt(0).toUpperCase()}</Text>
      </LinearGradient>
      <View style={styles.flex}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {community.name}
          </Text>
          <MaterialCommunityIcons
            name={closed ? 'lock' : 'earth'}
            size={13}
            color={colors.textMuted}
          />
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {community.member_count} üye
          {community.my_role === 'owner' && ' · Kurucu'}
          {community.my_role === 'admin' && ' · Admin'}
          {community.my_status === 'pending' && ' · İstek gönderildi'}
        </Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  search: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl, flexGrow: 1 },
  sectionTitle: {
    color: colors.textMuted,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowPressed: { backgroundColor: colors.surfaceHi },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 18 },
  flex: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.text, fontWeight: '800', fontSize: 15, flexShrink: 1 },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  headerBtn: { paddingHorizontal: spacing.xs },
});
