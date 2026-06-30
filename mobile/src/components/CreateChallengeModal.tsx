import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, TextField } from './ui';
import { ChallengeMetric, METRICS, metricInfo } from '../lib/challenges';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

const DURATIONS = [
  { label: '1 hafta', days: 7 },
  { label: '1 ay', days: 30 },
  { label: '3 ay', days: 90 },
];

/**
 * Create-challenge sheet. When `inviteUserId` is set, the created challenge is
 * also offered to that rider as an invite (they get a push). Used both from the
 * challenges list (no invite) and from a rider's profile ("challenge them").
 */
export function CreateChallengeModal({
  visible,
  onClose,
  onCreated,
  inviteUserId,
  inviteName,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated?: () => void;
  inviteUserId?: number;
  inviteName?: string;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [metric, setMetric] = useState<ChallengeMetric>('distance');
  const [goal, setGoal] = useState('');
  const [durationDays, setDurationDays] = useState(30);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTitle('');
    setDesc('');
    setMetric('distance');
    setGoal('');
    setDurationDays(30);
  }, [visible]);

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
      const { data } = await api.post('/api/challenges', {
        title: title.trim(),
        description: desc.trim(),
        metric,
        goal: g,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
      if (inviteUserId && data?.id) {
        await api.post(`/api/challenges/${data.id}/invite`, { user_id: inviteUserId });
      }
      onClose();
      onCreated?.();
      if (inviteUserId) {
        Alert.alert('Meydan okundu', `${inviteName ?? 'Sürücü'} davet edildi ve bildirim gönderildi.`);
      }
    } catch (err) {
      Alert.alert('Oluşturulamadı', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>
              {inviteUserId ? `${inviteName ?? 'Sürücüye'} Meydan Oku` : 'Yeni Meydan Okuma'}
            </Text>
            <TextField label="Başlık" value={title} onChangeText={setTitle} placeholder="Haziran 1000 km" />
            <TextField label="Açıklama (opsiyonel)" value={desc} onChangeText={setDesc} placeholder="Yaz başı ısınma turu" />

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
            <Button title={inviteUserId ? 'Meydan Oku' : 'Başlat'} icon="flag-checkered" onPress={create} loading={saving} />
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
