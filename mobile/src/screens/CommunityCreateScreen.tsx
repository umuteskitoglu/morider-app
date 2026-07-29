import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Button, Card, Chip, TextField } from '../components/ui';
import { ChatStackParams } from '../navigation/RootNavigator';
import { CommunityPrivacy, createCommunity } from '../lib/communities';
import { errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

// CommunityCreateScreen — EventCreateScreen's simple form pattern: a couple of
// text fields plus the public/closed choice. The creator becomes the owner.
export default function CommunityCreateScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ChatStackParams>>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<CommunityPrivacy>('public');
  const [saving, setSaving] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Eksik bilgi', 'Topluluğa bir isim ver.');
      return;
    }
    try {
      setSaving(true);
      const community = await createCommunity({
        name: trimmed,
        description: description.trim() || undefined,
        privacy,
      });
      navigation.replace('CommunityDetail', { id: community.id, name: community.name });
    } catch (err) {
      Alert.alert('Oluşturulamadı', errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <TextField
          label="Topluluk Adı"
          icon="account-group"
          placeholder="Örn. İstanbul Gece Sürüşleri"
          value={name}
          onChangeText={setName}
          maxLength={80}
        />
        <TextField
          label="Açıklama"
          icon="text"
          placeholder="Topluluk ne hakkında? (isteğe bağlı)"
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={3}
          maxLength={1000}
          style={styles.multiline}
        />

        <Text style={styles.label}>Katılım</Text>
        <View style={styles.privacyRow}>
          <Chip
            label="Herkese Açık"
            icon="earth"
            active={privacy === 'public'}
            onPress={() => setPrivacy('public')}
          />
          <Chip label="Kapalı" icon="lock" active={privacy === 'closed'} onPress={() => setPrivacy('closed')} />
        </View>
        <Text style={styles.hint}>
          {privacy === 'public'
            ? 'İsteyen herkes anında katılabilir.'
            : 'Katılım istekleri admin onayından geçer.'}
        </Text>
      </Card>

      <Button title="Topluluğu Kur" icon="flag-checkered" onPress={create} loading={saving} />

      <Text style={styles.note}>
        Topluluğu kuran kişi yönetici olur: yayınları yalnızca yöneticiler paylaşır, üyeler yorum yapar.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  privacyRow: { flexDirection: 'row', gap: spacing.sm },
  hint: { color: colors.textMuted, fontSize: 13, marginTop: spacing.sm },
  note: { color: colors.textFaint, fontSize: 12, textAlign: 'center', paddingHorizontal: spacing.md },
});
