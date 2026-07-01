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
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fuel
  const [fuelLogs, setFuelLogs] = useState<FuelLog[]>([]);
  const [fuelSummary, setFuelSummary] = useState<FuelSummary | null>(null);
  const [addingFuel, setAddingFuel] = useState(false);
  const [savingFuel, setSavingFuel] = useState(false);
  const [fLiters, setFLiters] = useState('');
  const [fCost, setFCost] = useState('');
  const [fKm, setFKm] = useState('');
  const [fFull, setFFull] = useState(true);

  // Maintenance (merged with service history)
  const [maint, setMaint] = useState<MaintenanceItem[]>([]);
  const [odometer, setOdometer] = useState(0);
  const [addingMaint, setAddingMaint] = useState(false);
  const [savingMaint, setSavingMaint] = useState(false);
  const [mItem, setMItem] = useState('');
  const [mKm, setMKm] = useState('');
  const [mMonths, setMMonths] = useState('');

  // "Yapıldı" sheet — mark a maintenance item as done + record completion
  const [doneFor, setDoneFor] = useState<MaintenanceItem | null>(null);
  const [doneKm, setDoneKm] = useState('');
  const [doneCost, setDoneCost] = useState('');
  const [doneNote, setDoneNote] = useState('');
  const [savingDone, setSavingDone] = useState(false);

  // Expanded history per item (item id set)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Orphan service records — added before migration or via manual legacy flow
  const [orphans, setOrphans] = useState<ServiceRecord[]>([]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: moto?.name ?? name });
  }, [navigation, name, moto?.name]);

  const load = useCallback(async () => {
    try {
      const [g, m] = await Promise.all([
        api.get('/api/garage'),
        api.get(`/api/garage/${id}/maintenance`),
      ]);
      const found = (g.data.motorcycles ?? []).find((m: Motorcycle) => m.id === id) ?? null;
      setMoto(found);
      const items: MaintenanceItem[] = m.data.items ?? [];
      setMaint(items);
      setOdometer(m.data.odometer_km ?? 0);
      if (user?.id) syncMaintenanceReminders(id, name, items, user.id).catch(() => {});
    } catch (err) {
      Alert.alert('Yüklenemedi', errorMessage(err));
    }
    // Fuel (best effort)
    try {
      const { data } = await api.get(`/api/garage/${id}/fuel`);
      setFuelLogs(data.logs ?? []);
      setFuelSummary(data.summary ?? null);
    } catch {
      // ignore
    }
    // Orphan service records (best effort — records not linked to any schedule)
    try {
      const { data } = await api.get(`/api/garage/${id}/services`);
      const all: ServiceRecord[] = data.records ?? [];
      setOrphans(all.filter((r) => !r.maintenance_schedule_id));
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
    Alert.alert('Motoru sil', `"${moto?.name ?? name}" ve tüm kayıtları silinsin mi?`, [
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

  // ── Fuel ────────────────────────────────────────────────────────────────────

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
      await load();
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

  // ── Maintenance ──────────────────────────────────────────────────────────────

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

  function openDoneSheet(m: MaintenanceItem) {
    setDoneFor(m);
    setDoneKm(odometer > 0 ? String(odometer) : '');
    setDoneCost('');
    setDoneNote('');
  }

  async function saveDone() {
    if (!doneFor) return;
    try {
      setSavingDone(true);
      await api.post(`/api/garage/${id}/maintenance/${doneFor.id}/done`, {
        odometer_km: parseInt(doneKm, 10) || 0,
        cost: parseFloat(doneCost.replace(',', '.')) || 0,
        note: doneNote.trim(),
      });
      setDoneFor(null);
      await load();
    } catch (err) {
      Alert.alert('Kaydedilemedi', errorMessage(err));
    } finally {
      setSavingDone(false);
    }
  }

  function confirmDeleteMaint(m: MaintenanceItem) {
    Alert.alert('Bakım kalemini sil', `"${m.item}" ve tüm geçmişi silinsin mi?`, [
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

  function toggleExpand(itemId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Documents */}
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

      {/* Bakım — takvim + servis geçmişi birleşik */}
      <Card style={styles.docsCard}>
        <View style={styles.docsHead}>
          <Text style={styles.section}>Bakım</Text>
          <Pressable onPress={openAddMaint} hitSlop={8} style={styles.editBtn}>
            <MaterialCommunityIcons name="plus" size={16} color={colors.primary} />
            <Text style={styles.editText}>Kalem Ekle</Text>
          </Pressable>
        </View>

        {odometer > 0 && (
          <Text style={styles.odoLine}>
            <MaterialCommunityIcons name="counter" size={13} color={colors.textMuted} />
            {' '}Güncel km: {odometer.toLocaleString('tr-TR')}
          </Text>
        )}

        {maint.length === 0 ? (
          <Text style={styles.muted}>
            Yağ, lastik, zincir, fren… km ve/veya zaman aralığı ver; kalan ömrü takip et ve her bakımı buraya kaydet.
          </Text>
        ) : (
          maint.map((m, i) => {
            const st = maintenanceStatusInfo(m);
            const isExpanded = expanded.has(m.id);
            const hasHistory = m.records.length > 0;
            return (
              <View key={m.id} style={[styles.maintItem, i > 0 && styles.maintDivider]}>
                {/* Header row */}
                <View style={styles.maintHeader}>
                  <View style={[styles.statusDot, { backgroundColor: st.color, marginTop: 2 }]} />
                  <View style={styles.flex}>
                    <Text style={styles.maintName}>{m.item}</Text>
                    <Text style={styles.maintInterval}>
                      {[
                        m.interval_km ? `${m.interval_km.toLocaleString('tr-TR')} km` : '',
                        m.interval_months ? `${m.interval_months} ayda bir` : '',
                      ].filter(Boolean).join(' / ')}
                    </Text>
                  </View>
                  <View style={[styles.statusChip, { borderColor: st.color }]}>
                    <Text style={[styles.statusText, { color: st.color }]}>{st.text}</Text>
                  </View>
                </View>

                {/* Actions */}
                <View style={styles.maintActions}>
                  <Pressable style={styles.doneBtn} onPress={() => openDoneSheet(m)} hitSlop={6}>
                    <MaterialCommunityIcons name="check-circle-outline" size={16} color={colors.success} />
                    <Text style={styles.doneBtnText}>Yapıldı</Text>
                  </Pressable>
                  {hasHistory && (
                    <Pressable style={styles.histBtn} onPress={() => toggleExpand(m.id)} hitSlop={6}>
                      <MaterialCommunityIcons
                        name={isExpanded ? 'chevron-up' : 'history'}
                        size={16}
                        color={colors.primary}
                      />
                      <Text style={styles.histBtnText}>
                        {isExpanded ? 'Gizle' : `Geçmiş (${m.records.length})`}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => confirmDeleteMaint(m)} hitSlop={8} style={styles.deleteBtn}>
                    <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.textMuted} />
                  </Pressable>
                </View>

                {/* Inline history */}
                {isExpanded && hasHistory && (
                  <View style={styles.historyList}>
                    {m.records.map((rec, ri) => (
                      <View key={rec.id} style={[styles.historyRow, ri > 0 && styles.historyDivider]}>
                        <MaterialCommunityIcons name="wrench-clock" size={14} color={colors.textMuted} />
                        <View style={styles.flex}>
                          <Text style={styles.histDate}>{formatDateTR(rec.service_date)}</Text>
                          <Text style={styles.histMeta}>
                            {[
                              rec.odometer_km ? `${rec.odometer_km.toLocaleString('tr-TR')} km` : '',
                              rec.cost ? `${rec.cost.toLocaleString('tr-TR')} ₺` : '',
                              rec.note || '',
                            ].filter(Boolean).join(' · ')}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })
        )}

        {/* Orphan records (created before migration or via legacy API) */}
        {orphans.length > 0 && (
          <View style={styles.orphanSection}>
            <Text style={styles.orphanTitle}>Eski Kayıtlar</Text>
            {orphans.map((rec, i) => (
              <View key={rec.id} style={[styles.historyRow, i > 0 && styles.historyDivider]}>
                <MaterialCommunityIcons name="file-document-outline" size={14} color={colors.textMuted} />
                <View style={styles.flex}>
                  <Text style={styles.histDate}>{rec.title}</Text>
                  <Text style={styles.histMeta}>
                    {[
                      formatDateTR(rec.service_date),
                      rec.odometer_km ? `${rec.odometer_km.toLocaleString('tr-TR')} km` : '',
                      rec.cost ? `${rec.cost.toLocaleString('tr-TR')} ₺` : '',
                    ].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>

      <View style={{ height: spacing.lg }} />
      <Button title="Motoru Sil" variant="ghost" icon="trash-can-outline" onPress={confirmDeleteMoto} />

      <BikeFormModal visible={editing} initial={moto} saving={saving} onClose={() => setEditing(false)} onSave={saveEdit} />

      {/* Yakıt ekle */}
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

      {/* Bakım kalemi ekle */}
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
              <Text style={styles.hint}>En az birini doldur. Kalan ömür son bakımdan ve motorun güncel kilometresinden hesaplanır.</Text>
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="content-save" onPress={saveMaint} loading={savingMaint} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Bakım tamamlandı */}
      <Modal
        visible={doneFor !== null}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setDoneFor(null)}
      >
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => setDoneFor(null)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>
                {doneFor?.item} — Yapıldı
              </Text>
              <Text style={styles.muted}>Detayları doldur, kaydedince takvim sıfırlanır ve geçmişe eklenir.</Text>
              <TextField
                label="Kilometre"
                value={doneKm}
                onChangeText={setDoneKm}
                placeholder={odometer > 0 ? String(odometer) : '24500'}
                keyboardType="number-pad"
              />
              <View style={styles.row}>
                <View style={styles.flex}>
                  <TextField label="Tutar (₺, opsiyonel)" value={doneCost} onChangeText={setDoneCost} placeholder="1450" keyboardType="decimal-pad" />
                </View>
              </View>
              <TextField label="Not (opsiyonel)" value={doneNote} onChangeText={setDoneNote} placeholder="Motul 7100 10W40" />
              <View style={{ height: spacing.sm }} />
              <Button title="Kaydet" icon="check-circle-outline" onPress={saveDone} loading={savingDone} />
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

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
  odoLine: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.xs },
  // Maintenance item
  maintItem: { paddingVertical: spacing.sm },
  maintDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  maintHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  maintName: { color: colors.text, fontWeight: '800', fontSize: 14 },
  maintInterval: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  maintActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs, marginLeft: spacing.md + 7 },
  doneBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: spacing.sm, borderRadius: 999, borderWidth: 1, borderColor: colors.success },
  doneBtnText: { color: colors.success, fontSize: 12, fontWeight: '800' },
  histBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: spacing.sm, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  histBtnText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  deleteBtn: { marginLeft: 'auto' as any },
  historyList: { marginTop: spacing.sm, marginLeft: spacing.md + 7, gap: 2 },
  historyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 5 },
  historyDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  histDate: { color: colors.text, fontSize: 13, fontWeight: '700' },
  histMeta: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  // Orphan records section
  orphanSection: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  orphanTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '800', marginBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 0.5 },
  // Fuel
  metricRow: { flexDirection: 'row', gap: spacing.sm },
  metric: { flex: 1, alignItems: 'center', gap: 2, backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingVertical: spacing.sm },
  metricValue: { color: colors.text, fontWeight: '900', fontSize: 14 },
  metricLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  fuelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  // Sheet / modal
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: spacing.xs },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  toggleText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
});
