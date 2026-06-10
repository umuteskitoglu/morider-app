import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { RideStackParams } from '../navigation/RootNavigator';
import { Button, Card, TextField } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { colors, radius, spacing } from '../theme';

type ActiveSession = { session_id: number; code: string; participants: number; is_host: boolean };
type Props = NativeStackScreenProps<RideStackParams, 'GroupJoin'>;

// Pull a session code out of whatever the QR contained: a deep link
// (morider://join/ABC123, exp://.../--/join/ABC123) or the bare code itself.
export function codeFromQR(raw: string): string | null {
  const link = raw.match(/join[/=]([A-Za-z0-9]{4,8})/i);
  if (link) return link[1].toUpperCase();
  const bare = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,8}$/.test(bare) ? bare : null;
}

export default function GroupJoinScreen({ route, navigation }: Props) {
  const [code, setCode] = useState(route.params?.code?.toUpperCase() ?? '');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const autoJoined = useRef(false);

  const loadActive = useCallback(async () => {
    try {
      const { data } = await api.get('/api/sessions');
      setActive(data.sessions ?? []);
    } catch {
      // ignore — just won't show the rejoin list
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadActive();
    }, [loadActive]),
  );

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

  const join = useCallback(
    async (raw: string) => {
      const c = raw.trim().toUpperCase();
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
    },
    [navigation],
  );

  // Arriving via an invite link (morider://join/<code>) joins right away.
  useEffect(() => {
    const c = route.params?.code;
    if (c && !autoJoined.current) {
      autoJoined.current = true;
      join(c);
    }
  }, [route.params?.code, join]);

  async function openScanner() {
    if (!cameraPermission?.granted) {
      const res = await requestCameraPermission();
      if (!res.granted) {
        Alert.alert('İzin gerekli', 'QR kodu okutmak için kamera izni vermelisiniz.');
        return;
      }
    }
    scanned.current = false;
    setShowScanner(true);
  }

  function onScan(data: string) {
    if (scanned.current) return;
    const c = codeFromQR(data);
    if (!c) return; // unrelated QR — keep scanning
    scanned.current = true;
    setShowScanner(false);
    setCode(c);
    join(c);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Card style={styles.hero}>
        <MaterialCommunityIcons name="map-marker-radius" size={40} color={colors.primary} />
        <Text style={styles.heroTitle}>Birlikte Sür</Text>
        <Text style={styles.heroText}>
          Bir grup sürüşü başlat ve karşılıklı takip ettiğin arkadaşlarını davet et, ya da kod, link veya QR ile mevcut bir sürüşe katıl.
        </Text>
      </Card>

      {active.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Devam eden sürüşlerim</Text>
          {active.map((s) => (
            <Pressable key={s.session_id} onPress={() => navigation.navigate('GroupRide', { code: s.code })}>
              <Card style={styles.activeRow}>
                <View style={styles.activeIcon}>
                  <MaterialCommunityIcons name="motorbike" size={20} color={colors.primary} />
                </View>
                <View style={styles.activeBody}>
                  <Text style={styles.activeCode}>{s.code}</Text>
                  <Text style={styles.activeMeta}>
                    {s.participants} katılımcı{s.is_host ? ' · Host sensin' : ''}
                  </Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={24} color={colors.textMuted} />
              </Card>
            </Pressable>
          ))}
        </View>
      )}

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
        <Button title="Katıl" icon="login" onPress={() => join(code)} loading={joining} />
        <Button title="QR Kod Okut" variant="ghost" icon="qrcode-scan" onPress={openScanner} />
      </Card>

      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <View style={styles.scannerWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => onScan(data)}
          />
          <View style={styles.scannerOverlay} pointerEvents="none">
            <View style={styles.scannerFrame} />
            <Text style={styles.scannerHint}>Davet QR kodunu çerçeveye hizala</Text>
          </View>
          <Pressable style={styles.scannerClose} onPress={() => setShowScanner(false)} hitSlop={12}>
            <MaterialCommunityIcons name="close" size={26} color="#fff" />
          </Pressable>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg },
  heroTitle: { color: colors.text, fontSize: 20, fontWeight: '900' },
  heroText: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  activeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  activeIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,90,31,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeBody: { flex: 1 },
  activeCode: { color: colors.text, fontSize: 17, fontWeight: '900', letterSpacing: 2 },
  activeMeta: { color: colors.textMuted, fontSize: 13, marginTop: 1 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  or: { color: colors.textMuted, fontWeight: '700' },
  joinCard: { gap: spacing.sm },
  scannerWrap: { flex: 1, backgroundColor: '#000' },
  scannerOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  scannerFrame: {
    width: 240,
    height: 240,
    borderRadius: radius.lg,
    borderWidth: 3,
    borderColor: colors.primary,
    backgroundColor: 'transparent',
  },
  scannerHint: { color: '#fff', fontWeight: '700' },
  scannerClose: {
    position: 'absolute',
    top: 56,
    right: spacing.lg,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
