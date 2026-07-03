import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Chip, EmptyState } from '../components/ui';
import { ChatStackParams } from '../navigation/RootNavigator';
import {
  CommunityMember,
  approveRequest,
  demoteMember,
  fetchMembers,
  kickMember,
  promoteMember,
  rejectRequest,
} from '../lib/communities';
import { useAuth } from '../store/auth';
import { errorMessage } from '../api/client';
import { colors, gradients, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ChatStackParams, 'CommunityMembers'>;

const ROLE_LABEL: Record<string, string> = { owner: 'Kurucu', admin: 'Admin', member: 'Üye' };

// CommunityMembersScreen — the member directory. Admins get a second segment
// for pending join requests; the owner additionally manages roles.
export default function CommunityMembersScreen({ route }: Props) {
  const { id, myRole } = route.params;
  const { user } = useAuth();
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';

  const [segment, setSegment] = useState<'members' | 'requests'>('members');
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [requests, setRequests] = useState<CommunityMember[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(await fetchMembers(id));
      if (isAdmin) setRequests(await fetchMembers(id, 'pending'));
    } catch {
      // ignore; empty state renders
    }
  }, [id, isAdmin]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function act(fn: () => Promise<void>) {
    try {
      await fn();
      await load();
    } catch (err) {
      Alert.alert('Olmadı', errorMessage(err));
    }
  }

  function confirmKick(m: CommunityMember) {
    Alert.alert('Üye çıkarılsın mı?', `${m.name} topluluktan çıkarılacak.`, [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Çıkar', style: 'destructive', onPress: () => act(() => kickMember(id, m.user_id)) },
    ]);
  }

  const data = segment === 'requests' ? requests : members;

  return (
    <View style={styles.container}>
      {isAdmin && (
        <View style={styles.segments}>
          <Chip
            label={`Üyeler (${members.length})`}
            icon="account-group"
            active={segment === 'members'}
            onPress={() => setSegment('members')}
          />
          <Chip
            label={`İstekler (${requests.length})`}
            icon="account-clock"
            active={segment === 'requests'}
            onPress={() => setSegment('requests')}
          />
        </View>
      )}

      <FlatList
        data={data}
        keyExtractor={(m) => String(m.user_id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListEmptyComponent={
          segment === 'requests' ? (
            <EmptyState icon="account-clock-outline" title="Bekleyen istek yok" />
          ) : (
            <EmptyState icon="account-group-outline" title="Henüz üye yok" />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <LinearGradient colors={gradients.primary} style={styles.avatar}>
              <Text style={styles.avatarText}>{item.name?.charAt(0).toUpperCase() ?? '?'}</Text>
            </LinearGradient>
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
                {item.user_id === user?.id ? ' (sen)' : ''}
              </Text>
              <Text style={[styles.role, item.role !== 'member' && styles.roleAdmin]}>
                {segment === 'requests' ? 'Katılmak istiyor' : ROLE_LABEL[item.role] ?? item.role}
              </Text>
            </View>

            {segment === 'requests' ? (
              <View style={styles.actions}>
                <IconAction icon="check" color={colors.success} onPress={() => act(() => approveRequest(id, item.user_id))} />
                <IconAction icon="close" color={colors.danger} onPress={() => act(() => rejectRequest(id, item.user_id))} />
              </View>
            ) : (
              item.user_id !== user?.id &&
              item.role !== 'owner' && (
                <View style={styles.actions}>
                  {isOwner && item.role === 'member' && (
                    <IconAction
                      icon="shield-account"
                      color={colors.accent}
                      onPress={() =>
                        Alert.alert('Admin yap', `${item.name} artık yayın paylaşabilecek.`, [
                          { text: 'Vazgeç', style: 'cancel' },
                          { text: 'Admin Yap', onPress: () => act(() => promoteMember(id, item.user_id)) },
                        ])
                      }
                    />
                  )}
                  {isOwner && item.role === 'admin' && (
                    <IconAction
                      icon="shield-off"
                      color={colors.textMuted}
                      onPress={() =>
                        Alert.alert('Adminlikten al', `${item.name} normal üye olacak.`, [
                          { text: 'Vazgeç', style: 'cancel' },
                          { text: 'Adminlikten Al', onPress: () => act(() => demoteMember(id, item.user_id)) },
                        ])
                      }
                    />
                  )}
                  {isAdmin && (item.role === 'member' || isOwner) && (
                    <IconAction icon="account-remove" color={colors.danger} onPress={() => confirmKick(item)} />
                  )}
                </View>
              )
            )}
          </View>
        )}
      />
    </View>
  );
}

function IconAction({
  icon,
  color,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.iconBtn} onPress={onPress} hitSlop={6}>
      <MaterialCommunityIcons name={icon} size={19} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  segments: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, paddingBottom: 0 },
  list: { padding: spacing.md, flexGrow: 1 },
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
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  flex: { flex: 1 },
  name: { color: colors.text, fontWeight: '800', fontSize: 14 },
  role: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  roleAdmin: { color: colors.accent, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: spacing.xs },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
