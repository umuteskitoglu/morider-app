import React, { useEffect, useRef } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';

// Registry of UI elements the onboarding tour can spotlight. Screens mark
// their teachable elements with <TourTarget id="...">, and the tour overlay
// looks them up by id to measure where the spotlight hole should go.

export type TargetRect = { x: number; y: number; width: number; height: number };

const nodes = new Map<string, View>();

export function registerTourNode(id: string, node: View | null) {
  if (node) nodes.set(id, node);
  else nodes.delete(id);
}

// Measures a target in window coordinates. Resolves null when the target is
// not on screen (unmounted, or its screen isn't focused) so callers can skip
// that tour step instead of pointing at nothing.
export function measureTourTarget(id: string): Promise<TargetRect | null> {
  return new Promise((resolve) => {
    const node = nodes.get(id);
    if (!node) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) resolve({ x, y, width, height });
      else resolve(null);
    });
  });
}

// Wrapper that registers its own View under `id`. collapsable={false} keeps
// Android from optimizing the View away, which would break measureInWindow.
export function TourTarget({
  id,
  style,
  children,
}: {
  id: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const ref = useRef<View>(null);

  useEffect(() => {
    registerTourNode(id, ref.current);
    return () => registerTourNode(id, null);
  }, [id]);

  return (
    <View ref={ref} collapsable={false} style={style}>
      {children}
    </View>
  );
}
