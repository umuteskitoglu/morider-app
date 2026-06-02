import React, { useRef } from 'react';
import { Animated, ImageResizeMode, StyleProp, ImageStyle } from 'react-native';
import {
  PinchGestureHandler,
  PinchGestureHandlerStateChangeEvent,
  State,
} from 'react-native-gesture-handler';

// ZoomableImage adds Instagram-style pinch-to-zoom: zoom in around the pinch
// focal point while two fingers are down, then spring back to fit on release.
// Plays nicely with horizontal carousels and double-tap, since it only reacts
// to a two-finger pinch.
export function ZoomableImage({
  uri,
  width,
  height,
  style,
  resizeMode = 'contain',
}: {
  uri: string;
  width: number;
  height: number;
  style?: StyleProp<ImageStyle>;
  resizeMode?: ImageResizeMode;
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
      <Animated.Image
        source={{ uri }}
        resizeMode={resizeMode}
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
