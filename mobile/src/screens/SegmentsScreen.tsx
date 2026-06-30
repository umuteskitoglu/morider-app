import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Card } from '../components/ui';
import { Segment } from '../lib/segments';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'Segments'>;
type Tab = 'mine' | 'explore';

export default function SegmentsScreen({ navigation }: Props) {
  const [tab, setTab] = useState<Tab>('mine');
  const [segments, setSegments] = useState<Segment[]>([]);

  const load = useCallback(async (which: Tab) => {
    try {
      const { data } = await api.get(which === 'mine' ? '/api/segments' : '/api/segments/explore');
      setSegments(data.segments ?? []);
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(tab);
    }, [load, tab]),
  );

  function switchTab(next: Tab) {
    setTab(next);
    setSegments([]);
    load(next);
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <TabButton label="Segmentlerim" active={tab === 'mine'} onPress={() => switchTab('mine')} />
        <TabButton label="Keşfet" active={tab === 'explore'} onPress={() => switchTab('explore')} />
      </View>
      <FlatList
        data={segments}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Card>
            <Text style={styles.muted}>
              {tab === 'mine'
                ? 'Henüz segmentin yok. Bir sürüş detayından "Segment oluştur" ile yol parçanı kaydet.'
                : 'Keşfedilecek herkese açık segment yok.'}
            </Text>
          </Card>
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('SegmentDetail', { id: item.id, name: item.name })}>
            <Card style={styles.row}>
              <MaterialCommunityIcons name="flag-checkered" size={22} color={colors.primary} />
              <View style={styles.flex}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  {item.distance.toFixed(1)} km
                  {item.my_best_seconds ? ' · PR var' : ''}
                </Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  tabs: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabActive: { borderColor: colors.primary, backgroundColor: 'rgba(255,106,26,0.12)' },
  tabText: { color: colors.textMuted, fontWeight: '800', fontSize: 13 },
  tabTextActive: { color: colors.primary },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { color: colors.text, fontWeight: '800', fontSize: 15 },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  muted: { color: colors.textMuted },
});
