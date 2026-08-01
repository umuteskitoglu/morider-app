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

// Upper bound on how far a pinch can magnify the photo. Instagram caps zoom so
// the image can't blow up into a blurry mess, and the cap keeps the spring-back
// distance sane.
const MAX_SCALE = 4;

// ZoomableImage adds Instagram-style pinch-to-zoom: magnify around the pinch
// focal point while two fingers are down, then spring snappily back to fit on
// release. Plays nicely with horizontal carousels and double-tap, since it only
// reacts to a two-finger pinch.
export function ZoomableImage({
  uri,
  width,
  height,
  style,
  contentFit = 'contain',
  onPinchStart,
  onPinchEnd,
}: {
  uri: string;
  width: number;
  height: number;
  style?: StyleProp<ImageStyle>;
  contentFit?: 'contain' | 'cover' | 'fill';
  // Fired when two fingers engage / release so a parent can lift the photo above
  // its overlays and dim the background, Instagram-style.
  onPinchStart?: () => void;
  onPinchEnd?: () => void;
}) {
  // Raw values fed by the gesture; everything the image sees is derived from
  // these so the whole transform stays on the native driver (60fps).
  const pinchScale = useRef(new Animated.Value(1)).current;
  const focalX = useRef(new Animated.Value(width / 2)).current;
  const focalY = useRef(new Animated.Value(height / 2)).current;

  const onGestureEvent = Animated.event(
    [{ nativeEvent: { scale: pinchScale, focalX, focalY } }],
    { useNativeDriver: true },
  );

  function onStateChange(e: PinchGestureHandlerStateChangeEvent) {
    if (e.nativeEvent.state === State.ACTIVE) {
      onPinchStart?.();
    }
    if (e.nativeEvent.oldState === State.ACTIVE) {
      onPinchEnd?.();
      // Snap back fast and without bounce — a springy overshoot is what made the
      // old version feel loose instead of Instagram-tight.
      Animated.parallel([
        Animated.spring(pinchScale, { toValue: 1, useNativeDriver: true, bounciness: 0, speed: 20 }),
        Animated.spring(focalX, { toValue: width / 2, useNativeDriver: true, bounciness: 0, speed: 20 }),
        Animated.spring(focalY, { toValue: height / 2, useNativeDriver: true, bounciness: 0, speed: 20 }),
      ]).start();
    }
  }

  // Clamp: never shrink below fit, never magnify past MAX_SCALE. The clamped
  // value drives both the scale and the focal translation so they stay in sync.
  const scale = pinchScale.interpolate({
    inputRange: [1, MAX_SCALE],
    outputRange: [1, MAX_SCALE],
    extrapolate: 'clamp',
  });

  // Scale around the focal point (relative to the view centre) rather than the
  // centre: p' = s·p + (1 − s)·f. This single translate + scale is exact and
  // avoids the swimming the old five-transform stack produced.
  const oneMinusScale = Animated.subtract(1, scale);
  const translateX = Animated.multiply(oneMinusScale, Animated.subtract(focalX, width / 2));
  const translateY = Animated.multiply(oneMinusScale, Animated.subtract(focalY, height / 2));

  return (
    <PinchGestureHandler onGestureEvent={onGestureEvent} onHandlerStateChange={onStateChange}>
      <AnimatedImage
        source={uri}
        contentFit={contentFit}
        cachePolicy="memory-disk"
        // Tell expo-image this view is reused across list items: it releases the
        // previous bitmap instead of holding one per photo we ever scrolled past.
        recyclingKey={uri}
        // expo-image's default, pinned explicitly because the whole point here
        // is to decode at view size: a pinch scales the already-decoded texture,
        // so a multi-megapixel file never becomes a multi-megapixel bitmap.
        allowDownscaling
        transition={150}
        style={[
          style,
          {
            transform: [{ translateX }, { translateY }, { scale }],
          },
        ]}
      />
    </PinchGestureHandler>
  );
}
