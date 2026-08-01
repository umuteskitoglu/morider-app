import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { AuthStackParams } from '../navigation/RootNavigator';
import { useAuth } from '../store/auth';
import { Button, TextField } from '../components/ui';
import { errorMessage } from '../api/client';
import { colors, gradients, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<AuthStackParams, 'ForgotPassword'>;

// 'request' collects the address, 'verify' collects the mailed code and the new
// password. One screen rather than two: the rider has to leave the app to read
// the code, and coming back to a screen they recognise — with the address they
// typed still on it — is less disorienting than landing on a bare code field.
type Step = 'request' | 'verify';

export default function ForgotPasswordScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { requestPasswordReset, resetPassword } = useAuth();
  const [step, setStep] = useState<Step>('request');
  // Prefilled with whatever was typed on the login screen, so the rider who
  // already entered their address does not type it a second time.
  const [email, setEmail] = useState(route.params?.email ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onRequest() {
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert('Eksik bilgi', 'E-posta adresini gir.');
      return;
    }
    try {
      setLoading(true);
      await requestPasswordReset(trimmed);
      setEmail(trimmed);
      setStep('verify');
    } catch (err) {
      Alert.alert('Kod gönderilemedi', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onReset() {
    if (code.length !== 6) {
      Alert.alert('Eksik bilgi', 'E-postana gelen 6 haneli kodu gir.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Eksik bilgi', 'Yeni şifre en az 6 karakter olmalı.');
      return;
    }
    try {
      setLoading(true);
      // On success the rider is signed in, which swaps the whole navigator
      // over to the app — there is no screen to navigate to from here.
      await resetPassword(email.trim(), code, password);
    } catch (err) {
      Alert.alert('Şifre sıfırlanamadı', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <LinearGradient colors={gradients.hero} style={styles.container}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={styles.logoHalo}>
              <LinearGradient colors={gradients.primary} style={styles.logoBadge}>
                <MaterialCommunityIcons
                  name={step === 'request' ? 'lock-question' : 'email-check-outline'}
                  size={36}
                  color="#fff"
                />
              </LinearGradient>
            </View>
            <Text style={styles.title}>Şifremi Unuttum</Text>
            <Text style={styles.subtitle}>
              {step === 'request'
                ? 'Hesabının e-posta adresine 6 haneli bir kod gönderelim'
                : `${email} adresine gönderilen kodu ve yeni şifreni gir`}
            </Text>
          </View>

          <View style={styles.form}>
            {step === 'request' ? (
              <>
                <TextField
                  label="E-posta"
                  icon="email-outline"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  placeholder="ornek@morider.app"
                />
                <Button title="Kod Gönder" icon="send" onPress={onRequest} loading={loading} />
              </>
            ) : (
              <>
                <TextField
                  label="Doğrulama kodu"
                  icon="numeric"
                  value={code}
                  // Strip anything that is not a digit: the code is often
                  // pasted from a mail client, which brings whitespace with it.
                  onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                />
                <TextField
                  label="Yeni şifre"
                  icon="lock-outline"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  placeholder="En az 6 karakter"
                />

                <Button title="Şifreyi Değiştir" icon="lock-reset" onPress={onReset} loading={loading} />

                <Text style={styles.hint}>
                  Kod 15 dakika geçerli. E-posta gelmediyse spam klasörünü kontrol et.
                </Text>

                <Button
                  title="Kodu tekrar gönder"
                  variant="ghost"
                  icon="email-sync-outline"
                  onPress={onRequest}
                  disabled={loading}
                />
              </>
            )}

            <View style={{ height: spacing.md }} />
            <Button
              title="Girişe dön"
              variant="ghost"
              icon="arrow-left"
              onPress={() => navigation.goBack()}
              disabled={loading}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  header: { alignItems: 'center', marginBottom: spacing.lg },
  logoHalo: {
    width: 110,
    height: 110,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    backgroundColor: 'rgba(255,106,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,26,0.22)',
  },
  logoBadge: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
    ...shadow.glow,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '900', letterSpacing: 1 },
  subtitle: {
    color: colors.textMuted,
    marginTop: spacing.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  form: {
    backgroundColor: colors.glass,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.lg,
    ...shadow.card,
  },
});
