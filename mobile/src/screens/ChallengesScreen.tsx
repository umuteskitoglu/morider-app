import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { ProgressBar } from '../components/ProgressBar';
import { CreateChallengeModal } from '../components/CreateChallengeModal';
import { Challenge, fmtMetric, metricInfo, progressFraction, windowLabel } from '../lib/challenges';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'Challenges'>;

type Invite = {
  id: number;
  challenge_id: number;
  title: string;
  metric: Challenge['metric'];
  goal: number;
  inviter_name: string;
};

export default function ChallengesScreen({ navigation }: Props) {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ch, inv] = await Promise.all([
        api.get('/api/challenges'),
        api.get('/api/challenge-invites').catch(() => ({ data: { invites: [] } })),
      ]);
      setChallenges(ch.data.challenges ?? []);
      setInvites(inv.data.invites ?? []);
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => setCreating(true)} hitSlop={8} style={{ paddingHorizontal: spacing.xs }}>
          <MaterialCommunityIcons name="plus" size={24} color={colors.primary} />
        </Pressable>
      ),
    });
  }, [navigation]);

  async function respondInvite(inv: Invite, action: 'accept' | 'decline') {
    try {
      await api.post(`/api/challenge-invites/${inv.id}/${action}`);
      load();
      if (action === 'accept') {
        navigation.navigate('ChallengeDetail', { id: inv.challenge_id, name: inv.title });
      }
    } catch (err) {
      Alert.alert('İşlem başarısız', errorMessage(err));
    }
  }

  async function join(c: Challenge) {
    try {
      await api.post(`/api/challenges/${c.id}/join`);
      load();
    } catch (err) {
      Alert.alert('Katılınamadı', errorMessage(err));
    }
  }

  const header = invites.length > 0 && (
    <View style={styles.invites}>
      <Text style={styles.invitesTitle}>Davetler</Text>
      {invites.map((inv) => (
        <Card key={inv.id} style={styles.inviteCard}>
          <MaterialCommunityIcons name="flag-plus" size={20} color={colors.accent} />
          <View style={styles.flex}>
            <Text style={styles.inviteName} numberOfLines={1}>
              {inv.title}
            </Text>
            <Text style={styles.inviteMeta}>
              {inv.inviter_name} davet etti · {fmtMetric(inv.metric, inv.goal)}
            </Text>
          </View>
          <Pressable onPress={() => respondInvite(inv, 'accept')} hitSlop={6} style={styles.acceptBtn}>
            <MaterialCommunityIcons name="check" size={18} color={colors.bg} />
          </Pressable>
          <Pressable onPress={() => respondInvite(inv, 'decline')} hitSlop={6} style={styles.declineBtn}>
            <MaterialCommunityIcons name="close" size={18} color={colors.textMuted} />
          </Pressable>
        </Card>
      ))}
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={challenges}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={header || null}
        ListEmptyComponent={
          <Card>
            <Text style={styles.muted}>
              Aktif meydan okuma yok. Sağ üstten "+" ile bir tane başlat: mesafe, tırmanış, sürüş ya da hız hedefi koy.
            </Text>
          </Card>
        }
        renderItem={({ item }) => {
          const info = metricInfo(item.metric);
          const frac = progressFraction(item.my_progress, item.goal);
          const done = item.joined && frac >= 1;
          return (
            <Pressable onPress={() => navigation.navigate('ChallengeDetail', { id: item.id, name: item.title })}>
              <Card style={styles.card}>
                <View style={styles.headRow}>
                  <MaterialCommunityIcons name={info.icon as any} size={20} color={colors.primary} />
                  <Text style={styles.title} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.window}>{windowLabel(item)}</Text>
                </View>
                <Text style={styles.goal}>
                  Hedef: {fmtMetric(item.metric, item.goal)} · {item.participants} katılımcı
                </Text>
                {item.joined ? (
                  <View style={styles.progressWrap}>
                    <ProgressBar fraction={frac} color={done ? colors.success : colors.primary} />
                    <Text style={styles.progressText}>
                      {done ? '✓ Tamamlandı · ' : ''}
                      {fmtMetric(item.metric, item.my_progress)} / {fmtMetric(item.metric, item.goal)}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.joinRow}>
                    <Button title="Katıl" icon="flag-plus" onPress={() => join(item)} />
                  </View>
                )}
              </Card>
            </Pressable>
          );
        }}
      />

      <CreateChallengeModal visible={creating} onClose={() => setCreating(false)} onCreated={load} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  card: { gap: spacing.xs },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { color: colors.text, fontWeight: '900', fontSize: 15, flex: 1 },
  window: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  goal: { color: colors.textMuted, fontSize: 12 },
  progressWrap: { marginTop: spacing.xs, gap: 4 },
  progressText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  joinRow: { marginTop: spacing.sm },
  muted: { color: colors.textMuted },
  invites: { gap: spacing.sm, marginBottom: spacing.sm },
  invitesTitle: { color: colors.text, fontSize: 14, fontWeight: '900' },
  inviteCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderColor: colors.accent, borderWidth: 1 },
  inviteName: { color: colors.text, fontWeight: '800' },
  inviteMeta: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  acceptBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineBtn: {
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
