import React, { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type RouteItem = { id: number; name: string; description: string; distance: number };
type Props = NativeStackScreenProps<ProfileStackParams, 'RoutesList'>;

export default function RoutesScreen({ navigation }: Props) {
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await api.get('/api/routes');
      setRoutes(data.routes ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // One "import from file" action: the backend sniffs GPX vs KML from the
  // content, so the rider never has to know which format they have.
  async function importFile() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.[0]) return;
      setImporting(true);
      const content = await FileSystem.readAsStringAsync(picked.assets[0].uri);
      const { data } = await api.post('/api/routes/import', content, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      Alert.alert('İçe aktarıldı', `"${data.name}" (${(data.distance ?? 0).toFixed(2)} km) rotalarına eklendi.`);
      load();
    } catch (err) {
      Alert.alert('İçe aktarılamadı', errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  const remove = useCallback((item: RouteItem, close: () => void) => {
    Alert.alert('Rotayı sil', `"${item.name}" silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel', onPress: close },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/routes/${item.id}`);
            setRoutes((prev) => prev.filter((r) => r.id !== item.id));
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
            close();
          }
        },
      },
    ]);
  }, []);

  return (
    <View style={styles.container}>
      <FlatList
        data={routes}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListHeaderComponent={
          <View style={styles.headerRow}>
            <View style={styles.headerBtn}>
              <Button title="Yeni Rota" icon="plus" onPress={() => navigation.navigate('RouteCreate')} />
            </View>
            <View style={styles.headerBtn}>
              <Button title="Dosyadan İçe Aktar" variant="ghost" icon="upload-outline" onPress={importFile} loading={importing} />
            </View>
          </View>
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyWrap}>
              <MaterialCommunityIcons name="map-marker-path" size={48} color={colors.border} />
              <Text style={styles.empty}>{error ?? 'Henüz rota yok.\nYeni bir rota oluştur!'}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <RouteRow
            item={item}
            onOpen={() => navigation.navigate('RouteDetail', { id: item.id, name: item.name })}
            onDelete={remove}
          />
        )}
      />
    </View>
  );
}

function RouteRow({
  item,
  onOpen,
  onDelete,
}: {
  item: RouteItem;
  onOpen: () => void;
  onDelete: (item: RouteItem, close: () => void) => void;
}) {
  const ref = useRef<Swipeable>(null);

  // Red "Sil" panel revealed by swiping the row left.
  const renderRightActions = () => (
    <Pressable style={styles.deleteAction} onPress={() => onDelete(item, () => ref.current?.close())}>
      <MaterialCommunityIcons name="trash-can-outline" size={24} color="#fff" />
      <Text style={styles.deleteText}>Sil</Text>
    </Pressable>
  );

  return (
    <Swipeable ref={ref} renderRightActions={renderRightActions} overshootRight={false} rightThreshold={40}>
      <Pressable onPress={onOpen}>
        <Card style={styles.card}>
          <View style={styles.iconBadge}>
            <MaterialCommunityIcons name="map-marker-path" size={22} color={colors.primary} />
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            {item.description ? <Text style={styles.desc} numberOfLines={1}>{item.description}</Text> : null}
            <Text style={styles.distance}>{item.distance.toFixed(2)} km</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
        </Card>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  headerRow: { flexDirection: 'row', gap: spacing.sm },
  headerBtn: { flex: 1 },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(255,90,31,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1 },
  name: { color: colors.text, fontSize: 17, fontWeight: '800' },
  distance: { color: colors.primary, fontWeight: '800', marginTop: 2 },
  desc: { color: colors.textMuted, fontSize: 13 },
  deleteAction: {
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'center',
    width: 84,
    borderRadius: radius.md,
    marginLeft: spacing.sm,
    gap: 2,
  },
  deleteText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
});
