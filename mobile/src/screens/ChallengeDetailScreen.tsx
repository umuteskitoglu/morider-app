import React, { useCallback, useLayoutEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { ProgressBar } from '../components/ProgressBar';
import {
  Challenge,
  ChallengeStanding,
  fmtMetric,
  metricInfo,
  progressFraction,
  windowLabel,
} from '../lib/challenges';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'ChallengeDetail'>;

export default function ChallengeDetailScreen({ route, navigation }: Props) {
  const { id, name } = route.params;
  const { user } = useAuth();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [standings, setStandings] = useState<ChallengeStanding[]>([]);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/challenges/${id}`);
      setChallenge(data.challenge);
      setStandings(data.standings ?? []);
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function toggleJoin() {
    if (!challenge) return;
    try {
      setBusy(true);
      await api.post(`/api/challenges/${id}/${challenge.joined ? 'leave' : 'join'}`);
      await load();
    } catch (err) {
      Alert.alert('İşlem başarısız', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    Alert.alert('Meydan okumayı sil', `"${challenge?.title ?? name}" silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/challenges/${id}`);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          }
        },
      },
    ]);
  }

  if (!challenge) {
    return <View style={styles.container} />;
  }

  const info = metricInfo(challenge.metric);
  const isOwner = user?.id === challenge.creator_id;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.sm }}>
        <View style={styles.headRow}>
          <MaterialCommunityIcons name={info.icon as any} size={22} color={colors.primary} />
          <Text style={styles.title}>{challenge.title}</Text>
        </View>
        {challenge.description ? <Text style={styles.desc}>{challenge.description}</Text> : null}
        <Text style={styles.meta}>
          Hedef {fmtMetric(challenge.metric, challenge.goal)} · {challenge.participants} katılımcı · {windowLabel(challenge)}
        </Text>

        {challenge.joined && (
          <View style={styles.progressWrap}>
            <ProgressBar
              fraction={progressFraction(challenge.my_progress, challenge.goal)}
              color={progressFraction(challenge.my_progress, challenge.goal) >= 1 ? colors.success : colors.primary}
            />
            <Text style={styles.progressText}>
              Sen: {fmtMetric(challenge.metric, challenge.my_progress)} / {fmtMetric(challenge.metric, challenge.goal)}
            </Text>
          </View>
        )}

        <View style={{ height: spacing.xs }} />
        <Button
          title={challenge.joined ? 'Ayrıl' : 'Katıl'}
          variant={challenge.joined ? 'ghost' : 'primary'}
          icon={challenge.joined ? 'flag-remove' : 'flag-plus'}
          onPress={toggleJoin}
          loading={busy}
        />
      </Card>

      <Text style={styles.section}>Sıralama</Text>
      {standings.length === 0 ? (
        <Card>
          <Text style={styles.muted}>Henüz katılımcı yok.</Text>
        </Card>
      ) : (
        standings.map((s, i) => (
          <Card key={s.user_id} style={[styles.row, s.user_id === user?.id && styles.mine]}>
            <Text style={[styles.rank, i === 0 && { color: colors.accent }]}>{i + 1}</Text>
            <View style={styles.flex}>
              <Text style={styles.name}>
                {s.name}
                {s.completed ? '  ✓' : ''}
              </Text>
              <ProgressBar
                fraction={progressFraction(s.progress, challenge.goal)}
                color={s.completed ? colors.success : colors.primary}
              />
            </View>
            <Text style={styles.value}>{fmtMetric(challenge.metric, s.progress)}</Text>
          </Card>
        ))
      )}

      {isOwner && (
        <>
          <View style={{ height: spacing.md }} />
          <Button title="Meydan Okumayı Sil" variant="ghost" icon="trash-can-outline" onPress={remove} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  flex: { flex: 1 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', flex: 1 },
  desc: { color: colors.text, lineHeight: 20 },
  meta: { color: colors.textMuted, fontSize: 12 },
  progressWrap: { gap: 4, marginTop: spacing.xs },
  progressText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  section: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  mine: { borderColor: colors.primary, borderWidth: 1 },
  rank: { color: colors.text, fontSize: 18, fontWeight: '900', width: 26, textAlign: 'center' },
  name: { color: colors.text, fontWeight: '800', marginBottom: 4 },
  value: { color: colors.text, fontWeight: '900', fontVariant: ['tabular-nums'] },
  muted: { color: colors.textMuted },
});
