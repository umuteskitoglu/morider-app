import React, { useEffect, useLayoutEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { EventsStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { eventDraft } from '../lib/eventDraft';
import { scheduleEventReminders } from '../lib/eventReminders';
import { formatDateTime } from '../lib/datetime';
import { colors, radius, spacing } from '../theme';

type RouteItem = { id: number; name: string; distance: number };
type Picked = { lat: number; lon: number; name: string } | null;
type Props = NativeStackScreenProps<EventsStackParams, 'EventCreate'>;

// Default meet time: tomorrow 10:00; departure 15 minutes later.
function defaultMeet(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}

export default function EventCreateScreen({ navigation, route }: Props) {
  const editCode = route.params?.code;
  const isEdit = !!editCode;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [meetAt, setMeetAt] = useState<Date>(defaultMeet());
  const [startAt, setStartAt] = useState<Date>(() => {
    const d = defaultMeet();
    d.setMinutes(d.getMinutes() + 15);
    return d;
  });

  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [routeId, setRouteId] = useState<number | null>(null);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // Picked start/end live in the eventDraft module store; we mirror them into
  // state and re-sync on focus so returning from the map picker shows both.
  const [startPoint, setStartPoint] = useState<Picked>(eventDraft.start);
  const [endPoint, setEndPoint] = useState<Picked>(eventDraft.end);

  useFocusEffect(
    React.useCallback(() => {
      setStartPoint(eventDraft.start);
      setEndPoint(eventDraft.end);
    }, []),
  );

  useEffect(() => {
    api.get('/api/routes').then(({ data }) => setRoutes(data.routes ?? [])).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Etkinliği Düzenle' : 'Yeni Etkinlik' });
  }, [navigation, isEdit]);

  // Edit mode: prefill every field from the existing event.
  useEffect(() => {
    if (!editCode) return;
    let alive = true;
    api.get(`/api/events/${editCode}`).then(({ data }) => {
      if (!alive) return;
      setTitle(data.title ?? '');
      setDescription(data.description ?? '');
      if (data.meet_at) setMeetAt(new Date(data.meet_at));
      if (data.start_at) setStartAt(new Date(data.start_at));
      setRouteId(data.route_id ? data.route_id : null);
      const s: Picked =
        data.start_lat != null && data.start_lon != null
          ? { lat: data.start_lat, lon: data.start_lon, name: data.start_name ?? '' }
          : null;
      const e: Picked =
        data.end_lat != null && data.end_lon != null
          ? { lat: data.end_lat, lon: data.end_lon, name: data.end_name ?? '' }
          : null;
      eventDraft.setStart(s);
      eventDraft.setEnd(e);
      setStartPoint(s);
      setEndPoint(e);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [editCode]);

  const selectedRoute = routes.find((r) => r.id === routeId) ?? null;

  async function submit() {
    if (!title.trim()) {
      Alert.alert('Eksik bilgi', 'Lütfen bir başlık gir.');
      return;
    }
    if (meetAt.getTime() < Date.now()) {
      Alert.alert('Tarih hatası', 'Buluşma zamanı geçmişte olamaz.');
      return;
    }
    if (startAt < meetAt) {
      Alert.alert('Tarih hatası', 'Kalkış, buluşmadan önce olamaz.');
      return;
    }
    if (routeId == null && !startPoint) {
      Alert.alert('Konum gerekli', 'Bir rota seç ya da başlangıç konumunu işaretle.');
      return;
    }

    const body: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim(),
      meet_at: meetAt.toISOString(),
      start_at: startAt.toISOString(),
    };
    if (routeId != null) {
      body.route_id = routeId;
    } else if (startPoint) {
      body.start_lat = startPoint.lat;
      body.start_lon = startPoint.lon;
      body.start_name = startPoint.name;
      if (endPoint) {
        body.end_lat = endPoint.lat;
        body.end_lon = endPoint.lon;
        body.end_name = endPoint.name;
      }
    }

    try {
      setSubmitting(true);
      if (isEdit) {
        await api.patch(`/api/events/${editCode}`, body);
        eventDraft.reset();
        // Times/location may have changed → reschedule the host's reminders.
        scheduleEventReminders(editCode!, title.trim(), meetAt.toISOString()).catch(() => {});
        navigation.goBack();
      } else {
        const { data } = await api.post('/api/events', body);
        eventDraft.reset();
        // Host attends by default → schedule local reminders for them.
        scheduleEventReminders(data.code, title.trim(), meetAt.toISOString()).catch(() => {});
        navigation.replace('EventDetail', { code: data.code });
      }
    } catch (err) {
      Alert.alert(isEdit ? 'Güncellenemedi' : 'Oluşturulamadı', errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TextField label="Başlık" icon="format-title" value={title} onChangeText={setTitle} placeholder="Pazar Sabahı Sürüşü" />
      <TextField
        label="Açıklama"
        icon="text"
        value={description}
        onChangeText={setDescription}
        placeholder="Detaylar (opsiyonel)"
        multiline
      />

      <DateTimeField label="Buluşma" icon="map-marker-account" value={meetAt} onChange={setMeetAt} />
      <DateTimeField label="Kalkış" icon="flag-checkered" value={startAt} onChange={setStartAt} />

      <Text style={styles.label}>Rota (opsiyonel)</Text>
      <Pressable onPress={() => setRoutePickerOpen(true)}>
        <Card style={styles.selectRow}>
          <MaterialCommunityIcons name="map-marker-path" size={22} color={colors.primary} />
          <Text style={styles.selectText} numberOfLines={1}>
            {selectedRoute ? selectedRoute.name : 'Rota seçilmedi'}
          </Text>
          <MaterialCommunityIcons name="chevron-down" size={22} color={colors.textMuted} />
        </Card>
      </Pressable>

      {routeId == null && (
        <View style={styles.locationSection}>
          <Text style={styles.label}>Konumlar</Text>
          <LocationButton
            kind="start"
            point={startPoint}
            onPress={() => navigation.navigate('EventLocationPicker', { target: 'start' })}
          />
          <LocationButton
            kind="end"
            point={endPoint}
            onPress={() => navigation.navigate('EventLocationPicker', { target: 'end' })}
          />
          <Text style={styles.hint}>Başlangıç gerekli, bitiş opsiyoneldir.</Text>
        </View>
      )}

      <View style={styles.submit}>
        <Button title={isEdit ? 'Değişiklikleri Kaydet' : 'Etkinliği Oluştur'} icon="check" onPress={submit} loading={submitting} />
      </View>

      <Modal visible={routePickerOpen} animationType="slide" transparent onRequestClose={() => setRoutePickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setRoutePickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Rota seç</Text>
            <ScrollView style={styles.sheetList}>
              <Pressable
                style={styles.routeOption}
                onPress={() => {
                  setRouteId(null);
                  setRoutePickerOpen(false);
                }}
              >
                <MaterialCommunityIcons name="map-marker-off" size={20} color={colors.textMuted} />
                <Text style={styles.routeOptionText}>Rota yok (konum seç)</Text>
                {routeId == null ? <MaterialCommunityIcons name="check" size={20} color={colors.primary} /> : null}
              </Pressable>
              {routes.map((r) => (
                <Pressable
                  key={r.id}
                  style={styles.routeOption}
                  onPress={() => {
                    setRouteId(r.id);
                    setRoutePickerOpen(false);
                  }}
                >
                  <MaterialCommunityIcons name="map-marker-path" size={20} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.routeOptionText} numberOfLines={1}>{r.name}</Text>
                    <Text style={styles.routeOptionMeta}>{r.distance.toFixed(1)} km</Text>
                  </View>
                  {routeId === r.id ? <MaterialCommunityIcons name="check" size={20} color={colors.primary} /> : null}
                </Pressable>
              ))}
              {routes.length === 0 ? <Text style={styles.hint}>Henüz kayıtlı rotan yok.</Text> : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

function LocationButton({ kind, point, onPress }: { kind: 'start' | 'end'; point: Picked; onPress: () => void }) {
  const icon = kind === 'start' ? 'flag' : 'flag-checkered';
  const label = kind === 'start' ? 'Başlangıç' : 'Bitiş';
  return (
    <Pressable onPress={onPress}>
      <Card style={styles.selectRow}>
        <MaterialCommunityIcons name={icon} size={22} color={kind === 'start' ? colors.success : colors.danger} />
        <View style={{ flex: 1 }}>
          <Text style={styles.selectText} numberOfLines={1}>
            {point ? (point.name || `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`) : `${label} konumu seç`}
          </Text>
        </View>
        <MaterialCommunityIcons name="map-marker-plus" size={20} color={colors.textMuted} />
      </Card>
    </Pressable>
  );
}

// DateTimeField shows a formatted value and opens a native date+time picker.
// Android uses the imperative two-step (date → time) flow; iOS uses an inline
// spinner inside a modal sheet.
function DateTimeField({
  label,
  icon,
  value,
  onChange,
}: {
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  value: Date;
  onChange: (d: Date) => void;
}) {
  const [iosOpen, setIosOpen] = useState(false);
  const [iosTemp, setIosTemp] = useState<Date>(value);

  function open() {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value,
        mode: 'date',
        minimumDate: new Date(),
        onChange: (e, d) => {
          if (e.type !== 'set' || !d) return;
          const picked = d;
          DateTimePickerAndroid.open({
            value: picked,
            mode: 'time',
            is24Hour: true,
            onChange: (e2, t) => {
              if (e2.type !== 'set' || !t) return;
              const final = new Date(picked);
              final.setHours(t.getHours(), t.getMinutes(), 0, 0);
              onChange(final);
            },
          });
        },
      });
    } else {
      setIosTemp(value);
      setIosOpen(true);
    }
  }

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={open}>
        <Card style={styles.selectRow}>
          <MaterialCommunityIcons name={icon} size={22} color={colors.primary} />
          <Text style={styles.selectText}>{formatDateTime(value)}</Text>
          <MaterialCommunityIcons name="calendar-edit" size={20} color={colors.textMuted} />
        </Card>
      </Pressable>

      {Platform.OS === 'ios' && (
        <Modal visible={iosOpen} animationType="slide" transparent onRequestClose={() => setIosOpen(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setIosOpen(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <View style={styles.sheetHandle} />
              <DateTimePicker
                value={iosTemp}
                mode="datetime"
                display="spinner"
                themeVariant="dark"
                minimumDate={new Date()}
                onChange={(_, d) => d && setIosTemp(d)}
              />
              <Button
                title="Tamam"
                icon="check"
                onPress={() => {
                  onChange(iosTemp);
                  setIosOpen(false);
                }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },
  label: {
    color: colors.textMuted,
    marginBottom: spacing.xs,
    marginTop: spacing.sm,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  selectRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  selectText: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  locationSection: { gap: spacing.sm },
  hint: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },
  submit: { marginTop: spacing.lg },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    paddingTop: spacing.sm,
    maxHeight: '70%',
    gap: spacing.sm,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: spacing.xs },
  sheetList: { flexGrow: 0 },
  routeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  routeOptionText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  routeOptionMeta: { color: colors.textMuted, fontSize: 12 },
});
