import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';

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
      let url = which === 'mine' ? '/api/segments' : '/api/segments/explore';
      // Explore is far more useful sorted by proximity — send our position when
      // the user has already granted location (never prompt just for this list).
      if (which === 'explore') {
        const near = await nearbyCoords();
        if (near) url += `?lat=${near.lat}&lon=${near.lon}`;
      }
      const { data } = await api.get(url);
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
        <TabButton label="Kapışmalarım" active={tab === 'mine'} onPress={() => switchTab('mine')} />
        <TabButton label="Keşfet" active={tab === 'explore'} onPress={() => switchTab('explore')} />
      </View>
      <FlatList
        data={segments}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<IntroCard />}
        ListEmptyComponent={<EmptyState tab={tab} />}
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('SegmentDetail', { id: item.id, name: item.name })}>
            <Card style={styles.row}>
              <MaterialCommunityIcons name="flag-checkered" size={22} color={colors.primary} />
              <View style={styles.flex}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>{rowMeta(item)}</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

// IntroCard explains the feature so it does not sit unexplained in a corner of
// the app. Shown above both tabs.
function IntroCard() {
  return (
    <Card style={styles.intro}>
      <View style={styles.introHead}>
        <MaterialCommunityIcons name="flag-checkered" size={20} color={colors.primary} />
        <Text style={styles.introTitle}>Kapışma nedir?</Text>
      </View>
      <Text style={styles.introBody}>
        Sevdiğin bir yol parçasını kapışma olarak kaydet. Oradan her geçişinde süren otomatik ölçülür,
        diğer sürücülerle sıralanır ve rekor kırdıkça rozet kazanırsın.
      </Text>
      <Text style={styles.introHint}>
        Bir sürüşün detayından “Bu sürüşten kapışma oluştur” ile başla.
      </Text>
    </Card>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  return (
    <Card style={styles.empty}>
      <MaterialCommunityIcons name="map-marker-path" size={28} color={colors.textMuted} />
      <Text style={styles.emptyText}>
        {tab === 'mine'
          ? 'Henüz kapışman yok. Bir sürüş detayından "Bu sürüşten kapışma oluştur" ile ilk yol parçanı kaydet.'
          : 'Yakında herkese açık kapışma yok. İlk kapışmayı sen oluştur, arkadaşların da yarışsın!'}
      </Text>
    </Card>
  );
}

// rowMeta builds "3.4 km · 5 sürücü · +2 benzer · PR var" from whichever stats
// are present. "+N benzer" shows how many overlapping kapışmalar this row stands
// in for, so the deduped Keşfet list is transparent about the merge.
function rowMeta(s: Segment): string {
  const parts = [`${s.distance.toFixed(1)} km`];
  if (s.rider_count > 0) parts.push(`${s.rider_count} sürücü`);
  if (s.effort_count > 0) parts.push(`${s.effort_count} deneme`);
  if (s.variant_count > 0) parts.push(`+${s.variant_count} benzer`);
  if (s.my_best_seconds) parts.push('PR var');
  return parts.join(' · ');
}

// nearbyCoords returns the device position only if permission is already
// granted, so opening the Keşfet tab never triggers a permission prompt.
async function nearbyCoords(): Promise<{ lat: number; lon: number } | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: loc.coords.latitude, lon: loc.coords.longitude };
  } catch {
    return null;
  }
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
  intro: { gap: spacing.xs, marginBottom: spacing.sm },
  introHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  introTitle: { color: colors.text, fontWeight: '900', fontSize: 15 },
  introBody: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  introHint: { color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 2 },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  emptyText: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
