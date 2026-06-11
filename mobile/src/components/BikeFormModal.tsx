import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, TextField } from './ui';
import { DOC_ICONS, DOC_KEYS, DOC_LABELS, DocKey, formatDateTR, Motorcycle, toISODate } from '../lib/garage';
import { colors, radius, spacing } from '../theme';

export type BikeFormValues = {
  name: string;
  plate: string;
  year: number;
  insurance_expiry: string;
  kasko_expiry: string;
  inspection_expiry: string;
};

/**
 * Add/edit form for a garage motorcycle: name, plate, year and the three
 * document expiry dates. Pass `initial` to edit; omit to create.
 */
export function BikeFormModal({
  visible,
  initial,
  saving,
  onClose,
  onSave,
}: {
  visible: boolean;
  initial?: Motorcycle | null;
  saving: boolean;
  onClose: () => void;
  onSave: (values: BikeFormValues) => void;
}) {
  const [name, setName] = useState('');
  const [plate, setPlate] = useState('');
  const [year, setYear] = useState('');
  const [dates, setDates] = useState<Record<DocKey, string>>({
    insurance_expiry: '',
    kasko_expiry: '',
    inspection_expiry: '',
  });
  const [iosPicker, setIosPicker] = useState<DocKey | null>(null);
  const [iosTemp, setIosTemp] = useState<Date>(new Date());

  // Reset the form every time the modal opens.
  useEffect(() => {
    if (!visible) return;
    setName(initial?.name ?? '');
    setPlate(initial?.plate ?? '');
    setYear(initial?.year ? String(initial.year) : '');
    setDates({
      insurance_expiry: initial?.insurance_expiry ?? '',
      kasko_expiry: initial?.kasko_expiry ?? '',
      inspection_expiry: initial?.inspection_expiry ?? '',
    });
  }, [visible, initial]);

  function pickDate(key: DocKey) {
    const current = dates[key] ? new Date(`${dates[key]}T00:00:00`) : new Date();
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'date',
        onChange: (e, d) => {
          if (e.type === 'set' && d) setDates((prev) => ({ ...prev, [key]: toISODate(d) }));
        },
      });
    } else {
      setIosTemp(current);
      setIosPicker(key);
    }
  }

  function clearDate(key: DocKey) {
    setDates((prev) => ({ ...prev, [key]: '' }));
  }

  function submit() {
    onSave({
      name: name.trim(),
      plate: plate.trim().toUpperCase(),
      year: parseInt(year, 10) || 0,
      ...dates,
    });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.title}>{initial ? 'Motoru Düzenle' : 'Motor Ekle'}</Text>
              <TextField label="İsim" value={name} onChangeText={setName} placeholder="MT-07" />
              <View style={styles.row}>
                <View style={styles.flex}>
                  <TextField label="Plaka" value={plate} onChangeText={setPlate} placeholder="34 ABC 123" autoCapitalize="characters" />
                </View>
                <View style={{ width: spacing.sm }} />
                <View style={styles.yearBox}>
                  <TextField label="Yıl" value={year} onChangeText={setYear} placeholder="2022" keyboardType="number-pad" maxLength={4} />
                </View>
              </View>

              <Text style={styles.docsHeader}>Belge bitiş tarihleri</Text>
              <Text style={styles.docsHint}>
                Tarih girilen belgeler için 7 gün ve 1 gün kala cihaz bildirimi alırsın.
              </Text>
              {DOC_KEYS.map((key) => (
                <View key={key} style={styles.docRow}>
                  <MaterialCommunityIcons name={DOC_ICONS[key] as any} size={20} color={colors.primary} />
                  <Text style={styles.docLabel}>{DOC_LABELS[key]}</Text>
                  <Pressable style={styles.dateBtn} onPress={() => pickDate(key)}>
                    <Text style={[styles.dateText, !dates[key] && styles.dateEmpty]}>
                      {dates[key] ? formatDateTR(dates[key]) : 'Tarih seç'}
                    </Text>
                  </Pressable>
                  {dates[key] ? (
                    <Pressable onPress={() => clearDate(key)} hitSlop={8}>
                      <MaterialCommunityIcons name="close-circle" size={18} color={colors.textMuted} />
                    </Pressable>
                  ) : null}
                </View>
              ))}

              <View style={{ height: spacing.md }} />
              <Button title="Kaydet" icon="content-save" onPress={submit} loading={saving} />
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>

      {/* iOS date spinner */}
      {Platform.OS === 'ios' && (
        <Modal visible={iosPicker != null} animationType="slide" transparent onRequestClose={() => setIosPicker(null)}>
          <Pressable style={styles.backdrop} onPress={() => setIosPicker(null)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <DateTimePicker
                value={iosTemp}
                mode="date"
                display="spinner"
                themeVariant="dark"
                onChange={(_, d) => d && setIosTemp(d)}
              />
              <Button
                title="Tamam"
                icon="check"
                onPress={() => {
                  if (iosPicker) setDates((prev) => ({ ...prev, [iosPicker]: toISODate(iosTemp) }));
                  setIosPicker(null);
                }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}
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
    maxHeight: '88%',
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: spacing.sm },
  row: { flexDirection: 'row' },
  yearBox: { width: 110 },
  docsHeader: { color: colors.text, fontWeight: '800', fontSize: 13, marginTop: spacing.md },
  docsHint: { color: colors.textMuted, fontSize: 12, marginTop: 2, marginBottom: spacing.xs },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  docLabel: { color: colors.text, fontWeight: '700', flex: 1 },
  dateBtn: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  dateText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  dateEmpty: { color: colors.textMuted, fontWeight: '600' },
});
