import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { RoutesStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<RoutesStackParams, 'GroupJoin'>;

export default function GroupJoinScreen({ navigation }: Props) {
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  async function createSession() {
    try {
      setCreating(true);
      const { data } = await api.post('/api/sessions', {});
      navigation.replace('GroupRide', { code: data.code });
    } catch (err) {
      Alert.alert('Oluşturulamadı', errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function joinSession() {
    const c = code.trim().toUpperCase();
    if (!c) return;
    try {
      setJoining(true);
      await api.post(`/api/sessions/${c}/join`);
      navigation.replace('GroupRide', { code: c });
    } catch (err) {
      Alert.alert('Katılınamadı', errorMessage(err));
    } finally {
      setJoining(false);
    }
  }

  return (
    <View style={styles.container}>
      <Card style={styles.hero}>
        <MaterialCommunityIcons name="map-marker-radius" size={40} color={colors.primary} />
        <Text style={styles.heroTitle}>Birlikte Sür</Text>
        <Text style={styles.heroText}>
          Bir grup sürüşü başlat ve karşılıklı takip ettiğin arkadaşlarını davet et, ya da bir kodla mevcut bir sürüşe katıl.
        </Text>
      </Card>

      <Button title="Yeni Grup Sürüşü Başlat" icon="plus-circle" onPress={createSession} loading={creating} />

      <View style={styles.divider}>
        <View style={styles.line} />
        <Text style={styles.or}>veya</Text>
        <View style={styles.line} />
      </View>

      <Card style={styles.joinCard}>
        <TextField
          label="Oturum kodu"
          icon="key-variant"
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          placeholder="ABC123"
          maxLength={6}
        />
        <Button title="Katıl" icon="login" onPress={joinSession} loading={joining} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.md, gap: spacing.md },
  hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg },
  heroTitle: { color: colors.text, fontSize: 20, fontWeight: '900' },
  heroText: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  or: { color: colors.textMuted, fontWeight: '700' },
  joinCard: { gap: spacing.sm },
});
