import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, EmptyState, TouchCard } from '../components/ui';
import { BikeFormModal, BikeFormValues } from '../components/BikeFormModal';
import { DOC_KEYS, DOC_LABELS, expiryStatus, Motorcycle } from '../lib/garage';
import { syncGarageReminders } from '../lib/garageReminders';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'Garage'>;

export default function GarageScreen({ navigation }: Props) {
  const { user } = useAuth();
  const [motos, setMotos] = useState<Motorcycle[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const userId = user?.id;
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/api/garage');
      const list: Motorcycle[] = data.motorcycles ?? [];
      setMotos(list);
      // Re-sync the on-device expiry reminders with the fresh list.
      if (userId) syncGarageReminders(list, userId).catch(() => {});
    } catch {
      // pull-to-refresh shows the empty state; errors stay quiet
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function create(values: BikeFormValues) {
    if (!values.name) {
      Alert.alert('İsim gerekli', 'Motora bir isim ver.');
      return;
    }
    try {
      setSaving(true);
      await api.post('/api/garage', values);
      setAdding(false);
      load();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={motos}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListHeaderComponent={<Button title="Motor Ekle" icon="plus" onPress={() => setAdding(true)} />}
        ListEmptyComponent={
          !loading ? (
            <EmptyState
              icon="garage-variant"
              title="Garajın boş"
              hint="Motorunu ekle; sigorta, muayene ve kasko bitişlerini sana hatırlatalım."
            />
          ) : null
        }
        renderItem={({ item }) => (
          <TouchCard onPress={() => navigation.navigate('BikeDetail', { id: item.id, name: item.name })} style={styles.card}>
              <View style={styles.headRow}>
                <View style={styles.iconBadge}>
                  <MaterialCommunityIcons name="motorbike" size={22} color={colors.primary} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.sub}>
                    {[item.plate, item.year ? String(item.year) : ''].filter(Boolean).join(' • ') || 'Detay için dokun'}
                  </Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
              </View>
              <View style={styles.chipRow}>
                {DOC_KEYS.map((key) => {
                  const st = expiryStatus(item[key]);
                  if (st.level === 'none') return null;
                  return (
                    <View key={key} style={[styles.chip, { borderColor: st.color }]}>
                      <View style={[styles.chipDot, { backgroundColor: st.color }]} />
                      <Text style={styles.chipText}>
                        {DOC_LABELS[key]}: {st.text}
                      </Text>
                    </View>
                  );
                })}
              </View>
          </TouchCard>
        )}
      />

      <BikeFormModal visible={adding} saving={saving} onClose={() => setAdding(false)} onSave={create} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  card: { gap: spacing.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(255,106,26,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  name: { color: colors.text, fontSize: 17, fontWeight: '800' },
  sub: { color: colors.textMuted, fontSize: 13, marginTop: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
});
