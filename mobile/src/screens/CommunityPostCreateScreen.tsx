import React, { useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, Card, Chip, EmptyState } from '../components/ui';
import { ChatStackParams } from '../navigation/RootNavigator';
import { createPost } from '../lib/communities';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<ChatStackParams, 'CommunityPostCreate'>;

type PickedPhoto = { uri: string; mimeType?: string };
type RouteOption = { id: number; name: string; distance: number };
type EventOption = { id: number; code: string; title: string; start_at: string };

const MAX_POLL_OPTIONS = 6;

// CommunityPostCreateScreen — the admin broadcast composer: text + photos plus
// at most one attachment flavor of each kind (route, event, poll).
export default function CommunityPostCreateScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [saving, setSaving] = useState(false);

  const [routePick, setRoutePick] = useState<RouteOption | null>(null);
  const [eventPick, setEventPick] = useState<EventOption | null>(null);
  const [picker, setPicker] = useState<'route' | 'event' | null>(null);

  const [pollOn, setPollOn] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);

  async function pickPhotos() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.7,
    });
    if (!res.canceled) {
      setPhotos(res.assets.map((a) => ({ uri: a.uri, mimeType: a.mimeType })));
    }
  }

  async function publish() {
    const text = body.trim();
    const poll = pollOn
      ? { question: pollQuestion.trim(), options: pollOptions.map((o) => o.trim()).filter(Boolean) }
      : undefined;

    if (poll) {
      if (!poll.question) {
        Alert.alert('Eksik bilgi', 'Anket sorusunu yaz.');
        return;
      }
      if (poll.options.length < 2) {
        Alert.alert('Eksik bilgi', 'Anket için en az 2 seçenek gerekli.');
        return;
      }
    }
    if (!text && photos.length === 0 && !routePick && !eventPick && !poll) {
      Alert.alert('Boş yayın', 'Bir şeyler yaz veya bir ek seç.');
      return;
    }

    try {
      setSaving(true);
      await createPost(id, {
        body: text,
        photos: photos.map((p, i) => {
          const type = p.mimeType ?? 'image/jpeg';
          const ext = type.includes('png') ? 'png' : 'jpg';
          return { uri: p.uri, name: `photo${i}.${ext}`, type };
        }),
        routeId: routePick?.id,
        eventId: eventPick?.id,
        poll,
      });
      navigation.goBack();
    } catch (err) {
      Alert.alert('Paylaşılamadı', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <TextInput
          style={styles.body}
          value={body}
          onChangeText={setBody}
          placeholder="Topluluğa ne duyurmak istersin?"
          placeholderTextColor={colors.textFaint}
          multiline
        />
      </Card>

      {photos.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.photoRow}>
            {photos.map((p) => (
              <View key={p.uri}>
                <Image source={{ uri: p.uri }} style={styles.photoThumb} />
                <Pressable
                  style={styles.photoRemove}
                  onPress={() => setPhotos((list) => list.filter((x) => x.uri !== p.uri))}
                  hitSlop={6}
                >
                  <MaterialCommunityIcons name="close" size={14} color="#fff" />
                </Pressable>
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      <View style={styles.chipRow}>
        <Chip label={photos.length > 0 ? `${photos.length} fotoğraf` : 'Fotoğraf'} icon="image-plus" active={photos.length > 0} onPress={pickPhotos} />
        <Chip
          label={routePick ? routePick.name : 'Rota'}
          icon="map-marker-path"
          active={!!routePick}
          onPress={() => (routePick ? setRoutePick(null) : setPicker('route'))}
        />
        <Chip
          label={eventPick ? eventPick.title : 'Etkinlik'}
          icon="calendar-clock"
          active={!!eventPick}
          onPress={() => (eventPick ? setEventPick(null) : setPicker('event'))}
        />
        <Chip label="Anket" icon="poll" active={pollOn} onPress={() => setPollOn((v) => !v)} />
      </View>
      <Text style={styles.hint}>Aktif bir eke tekrar dokunmak onu kaldırır.</Text>

      {pollOn && (
        <Card>
          <TextInput
            style={styles.pollQuestion}
            value={pollQuestion}
            onChangeText={setPollQuestion}
            placeholder="Anket sorusu (örn. Pazar sürüşü nereye?)"
            placeholderTextColor={colors.textFaint}
          />
          {pollOptions.map((opt, i) => (
            <View key={i} style={styles.pollOptionRow}>
              <TextInput
                style={styles.pollOption}
                value={opt}
                onChangeText={(t) => setPollOptions((list) => list.map((x, j) => (j === i ? t : x)))}
                placeholder={`Seçenek ${i + 1}`}
                placeholderTextColor={colors.textFaint}
                maxLength={100}
              />
              {pollOptions.length > 2 && (
                <Pressable onPress={() => setPollOptions((list) => list.filter((_, j) => j !== i))} hitSlop={6}>
                  <MaterialCommunityIcons name="close" size={18} color={colors.textMuted} />
                </Pressable>
              )}
            </View>
          ))}
          {pollOptions.length < MAX_POLL_OPTIONS && (
            <Pressable style={styles.pollAdd} onPress={() => setPollOptions((list) => [...list, ''])}>
              <MaterialCommunityIcons name="plus" size={16} color={colors.primary} />
              <Text style={styles.pollAddText}>Seçenek ekle</Text>
            </Pressable>
          )}
        </Card>
      )}

      <Button title="Yayınla" icon="bullhorn" onPress={publish} loading={saving} />

      <AttachmentPicker
        kind={picker}
        onClose={() => setPicker(null)}
        onPickRoute={(r) => {
          setRoutePick(r);
          setPicker(null);
        }}
        onPickEvent={(e) => {
          setEventPick(e);
          setPicker(null);
        }}
      />
    </ScrollView>
  );
}

// AttachmentPicker lists the rider's saved routes or the events they can see,
// in a bottom-sheet style modal.
function AttachmentPicker({
  kind,
  onClose,
  onPickRoute,
  onPickEvent,
}: {
  kind: 'route' | 'event' | null;
  onClose: () => void;
  onPickRoute: (r: RouteOption) => void;
  onPickEvent: (e: EventOption) => void;
}) {
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  React.useEffect(() => {
    if (!kind) return;
    setLoaded(false);
    (async () => {
      try {
        if (kind === 'route') {
          const { data } = await api.get('/api/routes');
          setRoutes(data.routes ?? []);
        } else {
          const { data } = await api.get('/api/events');
          setEvents(data.events ?? []);
        }
      } catch {
        // empty state renders
      } finally {
        setLoaded(true);
      }
    })();
  }, [kind]);

  return (
    <Modal visible={kind !== null} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.modalScrim} onPress={onClose} />
      <View style={styles.modalSheet}>
        <Text style={styles.modalTitle}>{kind === 'route' ? 'Rota Seç' : 'Etkinlik Seç'}</Text>
        {kind === 'route' ? (
          <FlatList
            data={routes}
            keyExtractor={(r) => String(r.id)}
            ListEmptyComponent={loaded ? <EmptyState icon="map-marker-path" title="Kayıtlı rotan yok" /> : null}
            renderItem={({ item }) => (
              <Pressable style={styles.modalRow} onPress={() => onPickRoute(item)}>
                <MaterialCommunityIcons name="map-marker-path" size={20} color={colors.cyan} />
                <View style={styles.flex}>
                  <Text style={styles.modalRowTitle} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.modalRowMeta}>{(item.distance / 1000).toFixed(1)} km</Text>
                </View>
              </Pressable>
            )}
          />
        ) : (
          <FlatList
            data={events}
            keyExtractor={(e) => String(e.id)}
            ListEmptyComponent={loaded ? <EmptyState icon="calendar-blank" title="Etkinlik bulunamadı" /> : null}
            renderItem={({ item }) => (
              <Pressable style={styles.modalRow} onPress={() => onPickEvent(item)}>
                <MaterialCommunityIcons name="calendar-clock" size={20} color={colors.accent} />
                <View style={styles.flex}>
                  <Text style={styles.modalRowTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.modalRowMeta}>{item.code}</Text>
                </View>
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  flex: { flex: 1 },
  body: { color: colors.text, fontSize: 16, minHeight: 110, textAlignVertical: 'top' },
  photoRow: { flexDirection: 'row', gap: spacing.sm },
  photoThumb: { width: 84, height: 84, borderRadius: radius.md, backgroundColor: colors.bgAlt },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  hint: { color: colors.textFaint, fontSize: 12 },
  pollQuestion: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  pollOptionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  pollOption: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
  },
  pollAdd: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pollAddText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  modalSheet: {
    maxHeight: '65%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  modalTitle: { color: colors.text, fontWeight: '900', fontSize: 16, marginBottom: spacing.md, textAlign: 'center' },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalRowTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
  modalRowMeta: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
});
