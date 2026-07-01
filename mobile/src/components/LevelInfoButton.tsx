import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../theme';

// XP awarded per badge tier, mirroring TierXP in backend/internal/reward/rules.go.
// A completed challenge counts as gold (+50). Kept in sync manually since the
// backend is the source of truth; these are shown only as guidance to the rider.
const TIERS: { color: string; label: string; xp: number }[] = [
  { color: '#CD7F32', label: 'Bronz rozet', xp: 10 },
  { color: '#BFC6CE', label: 'Gümüş rozet', xp: 25 },
  { color: '#FFC93C', label: 'Altın rozet', xp: 50 },
  { color: '#7FE7E0', label: 'Platin rozet', xp: 100 },
];

// LevelInfoButton is a small "?" affordance that opens a sheet explaining how
// XP and levels work. Placed next to the "Seviye" section title on profiles.
export function LevelInfoButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={10}>
        <MaterialCommunityIcons name="information-outline" size={18} color={colors.primary} />
      </Pressable>

      <Modal visible={open} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.header}>
              <MaterialCommunityIcons name="star-four-points" size={20} color={colors.accent} />
              <Text style={styles.title}>Nasıl Seviye Atlanır?</Text>
            </View>

            <Text style={styles.body}>
              Seviye atlamak için <Text style={styles.strong}>XP</Text> toplarsın. XP yalnızca rozet
              kazandığında gelir — sürüş yaptıkça, rota paylaştıkça ve meydan okumaları tamamladıkça
              rozetler otomatik açılır.
            </Text>

            <Text style={styles.subTitle}>Rozet başına XP</Text>
            <View style={styles.tierCard}>
              {TIERS.map((t, i) => (
                <View key={t.label} style={[styles.tierRow, i > 0 && styles.tierDivider]}>
                  <MaterialCommunityIcons name="medal" size={18} color={t.color} />
                  <Text style={styles.tierLabel}>{t.label}</Text>
                  <Text style={styles.tierXp}>+{t.xp} XP</Text>
                </View>
              ))}
              <View style={[styles.tierRow, styles.tierDivider]}>
                <MaterialCommunityIcons name="flag-checkered" size={18} color="#FFC93C" />
                <Text style={styles.tierLabel}>Meydan okuma tamamla</Text>
                <Text style={styles.tierXp}>+50 XP</Text>
              </View>
            </View>

            <Text style={styles.subTitle}>Seviye eşikleri</Text>
            <Text style={styles.body}>
              Her seviye bir öncekinden 100 XP daha pahalıdır: 2. seviye için 100, 3. için 300, 4.
              için 600, 5. için 1000 XP… Böylece yükseldikçe atlamak zorlaşır.
            </Text>

            <Text style={styles.hint}>
              Sezon XP'si her ay sıfırlanır ve aylık liderlik tablosunu belirler; toplam XP ve
              seviyen kalıcıdır.
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { color: colors.text, fontWeight: '800', fontSize: 17 },
  body: { color: colors.textMuted, lineHeight: 20 },
  strong: { color: colors.text, fontWeight: '800' },
  subTitle: { color: colors.text, fontWeight: '800', fontSize: 13, marginTop: spacing.xs },
  tierCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  tierRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  tierDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  tierLabel: { color: colors.text, flex: 1, fontWeight: '600', fontSize: 14 },
  tierXp: { color: colors.accent, fontWeight: '800', fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.xs },
});
