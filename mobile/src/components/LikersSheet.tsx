import React, { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { api } from '../api/client';
import { colors, radius, spacing } from '../theme';

type Liker = { user_id: number; name: string };

// LikersSheet is a bottom-sheet modal listing the users who liked a post.
// Pass postId to open it; null keeps it closed.
export function LikersSheet({ postId, onClose }: { postId: number | null; onClose: () => void }) {
  const [likers, setLikers] = useState<Liker[]>([]);
  const navigation = useNavigation<any>();

  useEffect(() => {
    if (postId == null) return;
    setLikers([]);
    (async () => {
      try {
        const { data } = await api.get(`/api/posts/${postId}/likes`);
        setLikers(data.likers ?? []);
      } catch {
        setLikers([]);
      }
    })();
  }, [postId]);

  return (
    <Modal visible={postId != null} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.title}>Beğenenler</Text>
        <FlatList
          data={likers}
          keyExtractor={(item) => String(item.user_id)}
          ListEmptyComponent={<Text style={styles.muted}>Henüz beğeni yok.</Text>}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => {
                onClose();
                navigation.navigate('UserProfile', { userId: item.user_id, name: item.name });
              }}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.name?.charAt(0).toUpperCase() ?? 'M'}</Text>
              </View>
              <Text style={styles.name}>{item.name}</Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: '60%',
    gap: spacing.sm,
  },
  title: { color: colors.text, fontWeight: '800', fontSize: 16 },
  muted: { color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '900' },
  name: { color: colors.text, fontWeight: '600' },
});
