import React, { useRef } from 'react';
import { Animated, StyleProp } from 'react-native';
import { Image, ImageStyle } from 'expo-image';
import {
  PinchGestureHandler,
  PinchGestureHandlerStateChangeEvent,
  State,
} from 'react-native-gesture-handler';

// expo-image gives us disk caching and flicker-free loading; wrap it so it can
// still drive the pinch transform via the Animated API.
const AnimatedImage = Animated.createAnimatedComponent(Image);

// ZoomableImage adds Instagram-style pinch-to-zoom: zoom in around the pinch
// focal point while two fingers are down, then spring back to fit on release.
// Plays nicely with horizontal carousels and double-tap, since it only reacts
// to a two-finger pinch.
export function ZoomableImage({
  uri,
  width,
  height,
  style,
  contentFit = 'contain',
}: {
  uri: string;
  width: number;
  height: number;
  style?: StyleProp<ImageStyle>;
  contentFit?: 'contain' | 'cover' | 'fill';
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const focalX = useRef(new Animated.Value(0)).current;
  const focalY = useRef(new Animated.Value(0)).current;

  const onGestureEvent = Animated.event(
    [{ nativeEvent: { scale, focalX, focalY } }],
    { useNativeDriver: true },
  );

  function onStateChange(e: PinchGestureHandlerStateChangeEvent) {
    if (e.nativeEvent.oldState === State.ACTIVE) {
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.spring(focalX, { toValue: 0, useNativeDriver: true }),
        Animated.spring(focalY, { toValue: 0, useNativeDriver: true }),
      ]).start();
    }
  }

  // Translate so scaling happens around the focal point rather than the centre.
  const translateX = Animated.subtract(focalX, width / 2);
  const translateY = Animated.subtract(focalY, height / 2);

  return (
    <PinchGestureHandler onGestureEvent={onGestureEvent} onHandlerStateChange={onStateChange}>
      <AnimatedImage
        source={uri}
        contentFit={contentFit}
        cachePolicy="memory-disk"
        transition={150}
        style={[
          style,
          {
            transform: [
              { translateX },
              { translateY },
              { scale },
              { translateX: Animated.multiply(translateX, -1) },
              { translateY: Animated.multiply(translateY, -1) },
            ],
          },
        ]}
      />
    </PinchGestureHandler>
  );
}
