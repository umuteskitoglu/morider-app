import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { AuthStackParams } from '../navigation/RootNavigator';
import { useAuth } from '../store/auth';
import { Button, TextField } from '../components/ui';
import { errorMessage } from '../api/client';
import { colors, gradients, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<AuthStackParams, 'Login'>;

export default function LoginScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    if (!email || !password) {
      Alert.alert('Eksik bilgi', 'E-posta ve şifre gerekli.');
      return;
    }
    try {
      setLoading(true);
      await signIn(email.trim(), password);
    } catch (err) {
      Alert.alert('Giriş başarısız', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <LinearGradient colors={gradients.hero} style={styles.container}>
      <KeyboardAvoidingView
        style={[styles.flex, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.logoHalo}>
            <LinearGradient colors={gradients.primary} style={styles.logoBadge}>
              <MaterialCommunityIcons name="motorbike" size={46} color="#fff" />
            </LinearGradient>
          </View>
          <Text style={styles.logo}>MORIDER</Text>
          <Text style={styles.tagline}>SÜR · KAYDET · PAYLAŞ</Text>
          <Text style={styles.subtitle}>Motor tutkunları için yol arkadaşın</Text>
        </View>

        <View style={styles.form}>
          <TextField
            label="E-posta"
            icon="email-outline"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="ornek@morider.app"
          />
          <TextField
            label="Şifre"
            icon="lock-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
          />

          <Button title="Giriş Yap" icon="login" onPress={onSubmit} loading={loading} />
          <View style={{ height: spacing.md }} />
          <Button
            title="Hesap Oluştur"
            variant="ghost"
            icon="account-plus-outline"
            onPress={() => navigation.navigate('Signup')}
          />
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1, padding: spacing.lg, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  logoHalo: {
    width: 124,
    height: 124,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    backgroundColor: 'rgba(255,106,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.22)',
  },
  logoBadge: {
    width: 92,
    height: 92,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
    ...shadow.glow,
  },
  logo: { color: colors.text, fontSize: 42, fontWeight: '900', letterSpacing: 4 },
  tagline: { color: colors.primary, marginTop: spacing.xs, fontWeight: '800', fontSize: 12, letterSpacing: 2 },
  subtitle: { color: colors.textMuted, marginTop: spacing.sm, fontSize: 13, fontWeight: '500' },
  form: {
    backgroundColor: colors.glass,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.lg,
    ...shadow.card,
  },
});
