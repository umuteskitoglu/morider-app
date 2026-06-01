import React from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ZoomableImage } from './ZoomableImage';
import { radius, spacing } from '../theme';

// AvatarViewer shows a profile photo enlarged on a dimmed backdrop. Pinch to
// zoom; tap the backdrop or the close button to dismiss. Pass uri=null to hide.
export function AvatarViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const size = Math.min(width - spacing.lg * 2, 380);

  return (
    <Modal visible={!!uri} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      {/* GestureHandlerRootView is required for gestures to work inside a Modal on Android. */}
      <GestureHandlerRootView style={styles.flex}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          {uri ? (
            <ZoomableImage
              uri={uri}
              width={size}
              height={size}
              resizeMode="cover"
              style={[styles.img, { width: size, height: size }]}
            />
          ) : null}
          <View style={styles.close} pointerEvents="none">
            <MaterialCommunityIcons name="close" size={28} color="#fff" />
          </View>
        </Pressable>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  img: { borderRadius: radius.lg },
  close: { position: 'absolute', top: 54, right: spacing.md },
});
