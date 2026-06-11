import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ProfileStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { BikeFormModal, BikeFormValues } from '../components/BikeFormModal';
import {
  DOC_ICONS,
  DOC_KEYS,
  DOC_LABELS,
  expiryStatus,
  formatDateTR,
  Motorcycle,
  ServiceRecord,
} from '../lib/garage';
import { syncGarageReminders } from '../lib/garageReminders';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'BikeDetail'>;

export default function BikeDetailScreen({ route, navigation }: Props) {
  const { id, name } = route.params;
  const [moto, setMoto] = useState<Motorcycle | null>(null);
  const [records, setRecords] = useState<ServiceRecord[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingRecord, setAddingRecord] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);
  const [recTitle, setRecTitle] = useState('');
  const [recNote, setRecNote] = useState('');
  const [recKm, setRecKm] = useState('');
  const [recCost, setRecCost] = useState('');

  useLayoutEffect(() => {
    navigation.setOptions({ title: moto?.name ?? name });
  }, [navigation, name, moto?.name]);

  const load = useCallback(async () => {
    try {
      // No single-bike endpoint; the garage list is tiny, so find it there.
      const [g, s] = await Promise.all([
        api.get('/api/garage'),
        api.get(`/api/garage/${id}/services`),
      ]);
      const found = (g.data.motorcycles ?? []).find((m: Motorcycle) => m.id === id) ?? null;
      setMoto(found);
      setRecords(s.data.records ?? []);
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function saveEdit(values: BikeFormValues) {
    if (!values.name) {
      Alert.alert('İsim gerekli', 'Motora bir isim ver.');
      return;
    }
    try {
      setSaving(true);
      const { data } = await api.put(`/api/garage/${id}`, values);
      setMoto(data);
      setEditing(false);
      // Dates may have changed → refresh the on-device reminders.
      const { data: g } = await api.get('/api/garage');
      syncGarageReminders(g.motorcycles ?? []).catch(() => {});
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function confirmDeleteMoto() {
    Alert.alert('Motoru sil', `"${moto?.name ?? name}" ve tüm servis kayıtları silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/garage/${id}`);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          }
        },
      },
    ]);
  }

  function openAddRecord() {
    setRecTitle('');
    setRecNote('');
    setRecKm('');
    setRecCost('');
    setAddingRecord(true);
  }

  async function saveRecord() {
    if (!recTitle.trim()) {
      Alert.alert('Başlık gerekli', 'Yapılan işlemi yaz (örn. "Yağ + filtre").');
      return;
    }
    try {
      setSavingRecord(true);
      const { data } = await api.post(`/api/garage/${id}/services`, {
        title: recTitle.trim(),
        note: recNote.trim(),
        odometer_km: parseInt(recKm, 10) || 0,
        cost: parseFloat(recCost.replace(',', '.')) || 0,
      });
      setRecords((prev) => [data, ...prev]);
      setAddingRecord(false);
    } catch (err) {
      Alert.alert('Eklenemedi', errorMessage(err));
    } finally {
      setSavingRecord(false);
    }
  }

  function confirmDeleteRecord(rec: ServiceRecord) {
    Alert.alert('Kaydı sil', `"${rec.title}" silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/garage/${id}/services/${rec.id}`);
            setRecords((prev) => prev.filter((r) => r.id !== rec.id));
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Documents card */}
      <Card style={styles.docsCard}>
        <View style={styles.docsHead}>
          <Text style={styles.section}>Belgeler</Text>
          <Pressable onPress={() => setEditing(true)} hitSlop={8} style={styles.editBtn}>
            <MaterialCommunityIcons name="pencil" size={15} color={colors.primary} />
            <Text style={styles.editText}>Düzenle</Text>
          </Pressable>
        </View>
        {moto && (moto.plate || moto.year) ? (
          <Text style={styles.sub}>{[moto.plate, moto.year ? String(moto.year) : ''].filter(Boolean).join(' • ')}</Text>
        ) : null}
        {DOC_KEYS.map((key) => {
          const dateISO = moto?.[key] ?? '';
          const st = expiryStatus(dateISO);
          return (
            <View key={key} style={styles.docRow}>
              <MaterialCommunityIcons name={DOC_ICONS[key] as any} size={20} color={colors.primary} />
              <View style={styles.flex}>
                <Text style={styles.docLabel}>{DOC_LABELS[key]}</Text>
                <Text style={styles.docDate}>{formatDateTR(dateISO)}</Text>
              </View>
              <View style={[styles.statusChip, { borderColor: st.color }]}>
                <View style={[styles.statusDot, { backgroundColor: st.color }]} />
                <Text style={styles.statusText}>{st.text}</Text>
              </View>
            </View>
          );
        })}
      </Card>

      {/* Service log */}
      <View style={styles.logHead}>
        <Text style={styles.section}>Servis Defteri</Text>
        <Pressable onPress={openAddRecord} hitSlop={8} style={styles.editBtn}>
          <MaterialCommunityIcons name="plus" size={16} color={colors.primary} />
          <Text style={styles.editText}>Kayıt Ekle</Text>
        </Pressable>
      </View>
      {records.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            Henüz servis kaydı yok. Yağ değişimi, lastik, bakım… hepsini buraya işle.
          </Text>
        </Card>
      ) : (
        records.map((rec) => (
          <Card key={rec.id} style={styles.recCard}>
            <View style={styles.flex}>
              <Text style={styles.recTitle}>{rec.title}</Text>
              <Text style={styles.recMeta}>
                {[
                  formatDateTR(rec.service_date),
                  rec.odometer_km ? `${rec.odometer_km.toLocaleString('tr-TR')} km` : '',
                  rec.cost ? `${rec.cost.toLocaleString('tr-TR')} ₺` : '',
                ]
                  .filter(Boolean)
                  .join(' • ')}
              </Text>
              {rec.note ? <Text style={styles.recNote}>{rec.note}</Text> : null}
            </View>
            <Pressable onPress={() => confirmDeleteRecord(rec)} hitSlop={8}>
              <MaterialCommunityIcons name="trash-can-outline" size={20} color={colors.textMuted} />
            </Pressable>
          </Card>
        ))
      )}

      <View style={{ height: spacing.lg }} />
      <Button title="Motoru Sil" variant="ghost" icon="trash-can-outline" onPress={confirmDeleteMoto} />

      <BikeFormModal visible={editing} initial={moto} saving={saving} onClose={() => setEditing(false)} onSave={saveEdit} />

      {/* Add service record */}
      <Modal
        visible={addingRecord}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setAddingRecord(false)}
      >
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setAddingRecord(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Servis Kaydı</Text>
              <TextField label="Yapılan işlem" value={recTitle} onChangeText={setRecTitle} placeholder="Yağ + filtre değişimi" />
              <TextField label="Not (opsiyonel)" value={recNote} onChangeText={setRecNote} placeholder="Motul 7100 10W40" />
              <View style={styles.row}>
                <View style={styles.flex}>
                  <TextField label="Kilometre" value={recKm} onChangeText={setRecKm} placeholder="24500" keyboardType="number-pad" />
                </View>
                <View style={{ width: spacing.sm }} />
                <View style={styles.flex}>
                  <TextField label="Tutar (₺)" value={recCost} onChangeText={setRecCost} placeholder="1450" keyboardType="decimal-pad" />
                </View>
              </View>
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveRecord} loading={savingRecord} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  flex: { flex: 1 },
  row: { flexDirection: 'row' },
  section: { color: colors.text, fontSize: 16, fontWeight: '900' },
  sub: { color: colors.textMuted, fontSize: 13 },
  muted: { color: colors.textMuted },
  docsCard: { gap: spacing.sm },
  docsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  editText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  docLabel: { color: colors.text, fontWeight: '700' },
  docDate: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  logHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  recCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  recTitle: { color: colors.text, fontWeight: '800' },
  recMeta: { color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 2 },
  recNote: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: spacing.xs },
});
