import React, { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, spacing } from '../theme';

type Friend = { id: number; name: string; email: string };
type Request = { id: number; user: Friend };

export default function FriendsScreen() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, r] = await Promise.all([api.get('/api/friends'), api.get('/api/friends/requests')]);
      setFriends(f.data.friends ?? []);
      setRequests(r.data.requests ?? []);
    } catch {
      // ignore
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function sendRequest() {
    const e = email.trim();
    if (!e) return;
    try {
      setSending(true);
      await api.post('/api/friends/requests', { email: e });
      setEmail('');
      Alert.alert('İstek gönderildi', `${e} adresine arkadaşlık isteği gönderildi.`);
    } catch (err) {
      Alert.alert('Gönderilemedi', errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function accept(id: number) {
    try {
      await api.post(`/api/friends/requests/${id}/accept`);
      load();
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    }
  }

  async function decline(id: number) {
    try {
      await api.post(`/api/friends/requests/${id}/decline`);
      load();
    } catch (err) {
      Alert.alert('Hata', errorMessage(err));
    }
  }

  function remove(f: Friend) {
    Alert.alert('Arkadaşı çıkar', `${f.name} arkadaşlıktan çıkarılsın mı?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Çıkar',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/api/friends/${f.id}`);
            load();
          } catch (err) {
            Alert.alert('Hata', errorMessage(err));
          }
        },
      },
    ]);
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Card style={styles.addCard}>
        <TextField
          label="E-posta ile arkadaş ekle"
          icon="email-outline"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="arkadas@morider.app"
        />
        <Button title="İstek Gönder" icon="account-plus" onPress={sendRequest} loading={sending} />
      </Card>

      {requests.length > 0 && (
        <>
          <Text style={styles.section}>İstekler</Text>
          {requests.map((r) => (
            <Card key={r.id} style={styles.row}>
              <Avatar name={r.user.name} />
              <View style={styles.info}>
                <Text style={styles.name}>{r.user.name}</Text>
                <Text style={styles.email}>{r.user.email}</Text>
              </View>
              <Pressable style={styles.iconBtn} onPress={() => accept(r.id)} hitSlop={8}>
                <MaterialCommunityIcons name="check-circle" size={28} color={colors.success} />
              </Pressable>
              <Pressable style={styles.iconBtn} onPress={() => decline(r.id)} hitSlop={8}>
                <MaterialCommunityIcons name="close-circle" size={28} color={colors.textMuted} />
              </Pressable>
            </Card>
          ))}
        </>
      )}

      <Text style={styles.section}>Arkadaşlarım ({friends.length})</Text>
      {friends.length === 0 ? (
        <Card>
          <Text style={styles.muted}>Henüz arkadaşın yok. E-posta ile birini ekle!</Text>
        </Card>
      ) : (
        friends.map((f) => (
          <Card key={f.id} style={styles.row}>
            <Avatar name={f.name} />
            <View style={styles.info}>
              <Text style={styles.name}>{f.name}</Text>
              <Text style={styles.email}>{f.email}</Text>
            </View>
            <Pressable style={styles.iconBtn} onPress={() => remove(f)} hitSlop={8}>
              <MaterialCommunityIcons name="account-remove-outline" size={24} color={colors.danger} />
            </Pressable>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{name?.charAt(0).toUpperCase() ?? 'M'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  addCard: { gap: spacing.sm },
  section: { color: colors.text, fontWeight: '800', fontSize: 15, marginTop: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  info: { flex: 1 },
  name: { color: colors.text, fontWeight: '800' },
  email: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900' },
  iconBtn: { padding: spacing.xs },
});
