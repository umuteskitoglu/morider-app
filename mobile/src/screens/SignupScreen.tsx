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

type Props = NativeStackScreenProps<AuthStackParams, 'Signup'>;

export default function SignupScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    if (!name || !email || password.length < 6) {
      Alert.alert('Eksik bilgi', 'İsim, e-posta ve en az 6 karakter şifre gerekli.');
      return;
    }
    try {
      setLoading(true);
      await signUp(name.trim(), email.trim(), password);
    } catch (err) {
      Alert.alert('Kayıt başarısız', errorMessage(err));
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
          <LinearGradient colors={gradients.primary} style={styles.logoBadge}>
            <MaterialCommunityIcons name="account-plus" size={36} color="#fff" />
          </LinearGradient>
          <Text style={styles.title}>Aramıza Katıl</Text>
          <Text style={styles.subtitle}>Motor topluluğuna ilk vitesi tak</Text>
        </View>

        <View style={styles.form}>
          <TextField label="İsim" icon="account-outline" value={name} onChangeText={setName} placeholder="Umut" />
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
            placeholder="En az 6 karakter"
          />

          <Button title="Kayıt Ol" icon="motorbike" onPress={onSubmit} loading={loading} />
          <View style={{ height: spacing.md }} />
          <Button title="Zaten hesabım var" variant="ghost" icon="login" onPress={() => navigation.goBack()} />
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1, padding: spacing.lg, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: spacing.lg },
  logoBadge: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    transform: [{ rotate: '-6deg' }],
    ...shadow.glow,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '900', letterSpacing: 1 },
  subtitle: { color: colors.textMuted, marginTop: spacing.xs },
  form: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
});
