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
  FuelLog,
  FuelSummary,
  MaintenanceItem,
  maintenanceStatusInfo,
  Motorcycle,
  rangeKm,
  ServiceRecord,
} from '../lib/garage';
import { syncGarageReminders } from '../lib/garageReminders';
import { syncMaintenanceReminders } from '../lib/maintenanceReminders';
import { useAuth } from '../store/auth';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ProfileStackParams, 'BikeDetail'>;

export default function BikeDetailScreen({ route, navigation }: Props) {
  const { id, name } = route.params;
  const { user } = useAuth();
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

  // Fuel
  const [fuelLogs, setFuelLogs] = useState<FuelLog[]>([]);
  const [fuelSummary, setFuelSummary] = useState<FuelSummary | null>(null);
  const [addingFuel, setAddingFuel] = useState(false);
  const [savingFuel, setSavingFuel] = useState(false);
  const [fLiters, setFLiters] = useState('');
  const [fCost, setFCost] = useState('');
  const [fKm, setFKm] = useState('');
  const [fFull, setFFull] = useState(true);

  // Maintenance
  const [maint, setMaint] = useState<MaintenanceItem[]>([]);
  const [addingMaint, setAddingMaint] = useState(false);
  const [savingMaint, setSavingMaint] = useState(false);
  const [mItem, setMItem] = useState('');
  const [mKm, setMKm] = useState('');
  const [mMonths, setMMonths] = useState('');

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
    // Fuel logs + summary (best effort).
    try {
      const { data } = await api.get(`/api/garage/${id}/fuel`);
      setFuelLogs(data.logs ?? []);
      setFuelSummary(data.summary ?? null);
    } catch {
      // ignore
    }
    // Maintenance schedules (best effort).
    try {
      const { data } = await api.get(`/api/garage/${id}/maintenance`);
      const items = data.items ?? [];
      setMaint(items);
      // Schedule on-device reminders for time-based items (best effort).
      if (user?.id) syncMaintenanceReminders(id, name, items, user.id).catch(() => {});
    } catch {
      // ignore
    }
  }, [id, name, user?.id]);

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
      if (user?.id) {
        const { data: g } = await api.get('/api/garage');
        syncGarageReminders(g.motorcycles ?? [], user.id).catch(() => {});
      }
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

  function openAddFuel() {
    setFLiters('');
    setFCost('');
    setFKm('');
    setFFull(true);
    setAddingFuel(true);
  }

  async function saveFuel() {
    const liters = parseFloat(fLiters.replace(',', '.'));
    const km = parseInt(fKm, 10);
    if (!liters || !km) {
      Alert.alert('Eksik bilgi', 'Litre ve kilometre gerekli.');
      return;
    }
    try {
      setSavingFuel(true);
      await api.post(`/api/garage/${id}/fuel`, {
        liters,
        cost: parseFloat(fCost.replace(',', '.')) || 0,
        odometer_km: km,
        is_full_tank: fFull,
      });
      setAddingFuel(false);
      await load(); // refresh logs, summary and the bike's derived consumption
    } catch (err) {
      Alert.alert('Eklenemedi', errorMessage(err));
    } finally {
      setSavingFuel(false);
    }
  }

  function confirmDeleteFuel(log: FuelLog) {
    Alert.alert('Yakıt kaydını sil', `${log.liters} L kaydı silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/garage/${id}/fuel/${log.id}`);
            await load();
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          }
        },
      },
    ]);
  }

  function openAddMaint() {
    setMItem('');
    setMKm('');
    setMMonths('');
    setAddingMaint(true);
  }

  async function saveMaint() {
    if (!mItem.trim()) {
      Alert.alert('Başlık gerekli', 'Bakım kalemini yaz (örn. "Motor yağı").');
      return;
    }
    const km = parseInt(mKm, 10) || 0;
    const months = parseInt(mMonths, 10) || 0;
    if (!km && !months) {
      Alert.alert('Aralık gerekli', 'Km ve/veya ay aralığından en az birini gir.');
      return;
    }
    try {
      setSavingMaint(true);
      await api.post(`/api/garage/${id}/maintenance`, {
        item: mItem.trim(),
        interval_km: km,
        interval_months: months,
      });
      setAddingMaint(false);
      await load();
    } catch (err) {
      Alert.alert('Eklenemedi', errorMessage(err));
    } finally {
      setSavingMaint(false);
    }
  }

  async function markMaintDone(m: MaintenanceItem) {
    try {
      await api.post(`/api/garage/${id}/maintenance/${m.id}/done`);
      await load();
    } catch (err) {
      Alert.alert('Güncellenemedi', errorMessage(err));
    }
  }

  function confirmDeleteMaint(m: MaintenanceItem) {
    Alert.alert('Bakım kalemini sil', `"${m.item}" silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/garage/${id}/maintenance/${m.id}`);
            setMaint((prev) => prev.filter((x) => x.id !== m.id));
          } catch (err) {
            Alert.alert('Silinemedi', errorMessage(err));
          }
        },
      },
    ]);
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

      {/* Fuel & range */}
      <Card style={styles.docsCard}>
        <View style={styles.docsHead}>
          <Text style={styles.section}>Yakıt & Menzil</Text>
          <Pressable onPress={openAddFuel} hitSlop={8} style={styles.editBtn}>
            <MaterialCommunityIcons name="plus" size={16} color={colors.primary} />
            <Text style={styles.editText}>Yakıt Ekle</Text>
          </Pressable>
        </View>
        <View style={styles.metricRow}>
          <Metric
            icon="gas-station"
            label="Tüketim"
            value={fuelSummary?.avg_consumption ? `${fuelSummary.avg_consumption.toFixed(1)} L/100` : '—'}
          />
          <Metric
            icon="map-marker-distance"
            label="Menzil"
            value={(() => {
              const r = moto ? rangeKm(moto.tank_liters, moto.avg_consumption) : null;
              return r ? `${Math.round(r)} km` : '—';
            })()}
          />
          <Metric
            icon="cash"
            label="km başı"
            value={fuelSummary?.cost_per_km ? `${fuelSummary.cost_per_km.toFixed(2)} ₺` : '—'}
          />
        </View>
        {fuelLogs.length === 0 ? (
          <Text style={styles.muted}>
            Henüz yakıt kaydı yok. Her dolumda litre + kilometreyi gir; tüketim ve menzil otomatik hesaplanır.
          </Text>
        ) : (
          fuelLogs.slice(0, 5).map((log) => (
            <View key={log.id} style={styles.fuelRow}>
              <MaterialCommunityIcons
                name={log.is_full_tank ? 'fuel' : 'fuel-cell'}
                size={18}
                color={colors.textMuted}
              />
              <View style={styles.flex}>
                <Text style={styles.docLabel}>
                  {log.liters} L{log.cost ? ` · ${log.cost.toLocaleString('tr-TR')} ₺` : ''}
                </Text>
                <Text style={styles.docDate}>
                  {formatDateTR(log.filled_at)} · {log.odometer_km.toLocaleString('tr-TR')} km
                  {log.is_full_tank ? '' : ' · kısmi'}
                </Text>
              </View>
              <Pressable onPress={() => confirmDeleteFuel(log)} hitSlop={8}>
                <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.textMuted} />
              </Pressable>
            </View>
          ))
        )}
      </Card>

      {/* Maintenance schedules */}
      <Card style={styles.docsCard}>
        <View style={styles.docsHead}>
          <Text style={styles.section}>Bakım Takvimi</Text>
          <Pressable onPress={openAddMaint} hitSlop={8} style={styles.editBtn}>
            <MaterialCommunityIcons name="plus" size={16} color={colors.primary} />
            <Text style={styles.editText}>Kalem Ekle</Text>
          </Pressable>
        </View>
        {maint.length === 0 ? (
          <Text style={styles.muted}>
            Yağ, lastik, zincir, fren… km ve/veya zaman aralığı ver, kalan ömrü buradan takip et.
          </Text>
        ) : (
          maint.map((m) => {
            const st = maintenanceStatusInfo(m);
            return (
              <View key={m.id} style={styles.docRow}>
                <MaterialCommunityIcons name="wrench" size={20} color={colors.primary} />
                <View style={styles.flex}>
                  <Text style={styles.docLabel}>{m.item}</Text>
                  <Text style={styles.docDate}>
                    {[m.interval_km ? `${m.interval_km.toLocaleString('tr-TR')} km` : '', m.interval_months ? `${m.interval_months} ay` : '']
                      .filter(Boolean)
                      .join(' / ')}
                  </Text>
                </View>
                <View style={[styles.statusChip, { borderColor: st.color }]}>
                  <View style={[styles.statusDot, { backgroundColor: st.color }]} />
                  <Text style={styles.statusText}>{st.text}</Text>
                </View>
                <Pressable onPress={() => markMaintDone(m)} hitSlop={8}>
                  <MaterialCommunityIcons name="check-circle-outline" size={20} color={colors.success} />
                </Pressable>
                <Pressable onPress={() => confirmDeleteMaint(m)} hitSlop={8}>
                  <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.textMuted} />
                </Pressable>
              </View>
            );
          })
        )}
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

      {/* Add fuel log */}
      <Modal visible={addingFuel} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setAddingFuel(false)}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setAddingFuel(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Yakıt Kaydı</Text>
              <View style={styles.row}>
                <View style={styles.flex}>
                  <TextField label="Litre" value={fLiters} onChangeText={setFLiters} placeholder="12.5" keyboardType="decimal-pad" />
                </View>
                <View style={{ width: spacing.sm }} />
                <View style={styles.flex}>
                  <TextField label="Kilometre" value={fKm} onChangeText={setFKm} placeholder="24500" keyboardType="number-pad" />
                </View>
              </View>
              <TextField label="Tutar (₺, opsiyonel)" value={fCost} onChangeText={setFCost} placeholder="700" keyboardType="decimal-pad" />
              <Pressable style={styles.toggleRow} onPress={() => setFFull((v) => !v)} hitSlop={8}>
                <MaterialCommunityIcons
                  name={fFull ? 'checkbox-marked' : 'checkbox-blank-outline'}
                  size={22}
                  color={fFull ? colors.primary : colors.textMuted}
                />
                <Text style={styles.toggleText}>Depoyu tam doldurdum</Text>
              </Pressable>
              <Text style={styles.hint}>Tüketim hesabı yalnızca tam dolumlardan yapılır.</Text>
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveFuel} loading={savingFuel} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add maintenance schedule */}
      <Modal visible={addingMaint} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setAddingMaint(false)}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setAddingMaint(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Bakım Kalemi</Text>
              <TextField label="Kalem" value={mItem} onChangeText={setMItem} placeholder="Motor yağı" />
              <View style={styles.row}>
                <View style={styles.flex}>
                  <TextField label="Her (km)" value={mKm} onChangeText={setMKm} placeholder="6000" keyboardType="number-pad" />
                </View>
                <View style={{ width: spacing.sm }} />
                <View style={styles.flex}>
                  <TextField label="Her (ay)" value={mMonths} onChangeText={setMMonths} placeholder="12" keyboardType="number-pad" />
                </View>
              </View>
              <Text style={styles.hint}>En az birini doldur. Kalan ömür, son bakımdan ve motorun güncel kilometresinden hesaplanır.</Text>
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveMaint} loading={savingMaint} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

// Metric is a compact icon + value + label tile used in the fuel summary row.
function Metric({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <MaterialCommunityIcons name={icon} size={18} color={colors.primary} />
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
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
  metricRow: { flexDirection: 'row', gap: spacing.sm },
  metric: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
  },
  metricValue: { color: colors.text, fontWeight: '900', fontSize: 14 },
  metricLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  fuelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  toggleText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
});
