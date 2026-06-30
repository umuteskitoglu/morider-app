import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { ProgressBar } from '../components/ProgressBar';
import {
  Challenge,
  ChallengeMetric,
  fmtMetric,
  METRICS,
  metricInfo,
  progressFraction,
  windowLabel,
} from '../lib/challenges';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'Challenges'>;

const DURATIONS = [
  { label: '1 hafta', days: 7 },
  { label: '1 ay', days: 30 },
  { label: '3 ay', days: 90 },
];

export default function ChallengesScreen({ navigation }: Props) {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [metric, setMetric] = useState<ChallengeMetric>('distance');
  const [goal, setGoal] = useState('');
  const [durationDays, setDurationDays] = useState(30);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/challenges');
      setChallenges(data.challenges ?? []);
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
        <Pressable onPress={openCreate} hitSlop={8} style={{ paddingHorizontal: spacing.xs }}>
          <MaterialCommunityIcons name="plus" size={24} color={colors.primary} />
        </Pressable>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation]);

  function openCreate() {
    setTitle('');
    setDesc('');
    setMetric('distance');
    setGoal('');
    setDurationDays(30);
    setCreating(true);
  }

  async function join(c: Challenge) {
    try {
      await api.post(`/api/challenges/${c.id}/join`);
      load();
    } catch (err) {
      Alert.alert('Katılınamadı', errorMessage(err));
    }
  }

  async function create() {
    const g = parseFloat(goal.replace(',', '.'));
    if (!title.trim() || !g) {
      Alert.alert('Eksik bilgi', 'Başlık ve hedef gerekli.');
      return;
    }
    try {
      setSaving(true);
      const startsAt = new Date();
      const endsAt = new Date(startsAt.getTime() + durationDays * 86_400_000);
      await api.post('/api/challenges', {
        title: title.trim(),
        description: desc.trim(),
        metric,
        goal: g,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
      setCreating(false);
      load();
    } catch (err) {
      Alert.alert('Oluşturulamadı', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={challenges}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Card>
            <Text style={styles.muted}>
              Aktif meydan okuma yok. Sağ üstten "+" ile bir tane başlat: mesafe, tırmanış ya da sürüş sayısı hedefi koy.
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

      <Modal visible={creating} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setCreating(false)}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setCreating(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Yeni Meydan Okuma</Text>
              <TextField label="Başlık" value={title} onChangeText={setTitle} placeholder="Haziran 1000 km" />
              <TextField label="Açıklama (opsiyonel)" value={desc} onChangeText={setDesc} placeholder="Yaz başı için ısınma turu" />

              <Text style={styles.fieldLabel}>Metrik</Text>
              <View style={styles.pillWrap}>
                {METRICS.map((m) => (
                  <Pressable
                    key={m.key}
                    style={[styles.pillAuto, metric === m.key && styles.pillActive]}
                    onPress={() => setMetric(m.key)}
                  >
                    <Text style={[styles.pillText, metric === m.key && styles.pillTextActive]}>{m.label}</Text>
                  </Pressable>
                ))}
              </View>

              <TextField
                label={`Hedef (${metricInfo(metric).unit})`}
                value={goal}
                onChangeText={setGoal}
                placeholder={metric === 'rides' ? '20' : metric === 'elevation' ? '5000' : '1000'}
                keyboardType="decimal-pad"
              />

              <Text style={styles.fieldLabel}>Süre</Text>
              <View style={styles.pillRow}>
                {DURATIONS.map((d) => (
                  <Pressable
                    key={d.days}
                    style={[styles.pill, durationDays === d.days && styles.pillActive]}
                    onPress={() => setDurationDays(d.days)}
                  >
                    <Text style={[styles.pillText, durationDays === d.days && styles.pillTextActive]}>{d.label}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={{ height: spacing.md }} />
              <Button title="Başlat" icon="flag-checkered" onPress={create} loading={saving} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
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
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: spacing.sm },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  pillRow: { flexDirection: 'row', gap: spacing.sm },
  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgAlt,
  },
  pillAuto: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgAlt,
  },
  pillActive: { borderColor: colors.primary, backgroundColor: 'rgba(255,106,26,0.12)' },
  pillText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  pillTextActive: { color: colors.primary },
});
