import { useEffect, useRef } from 'react';
import { Accelerometer } from 'expo-sensors';

// Crash heuristic: a hard impact shows up as a short total-acceleration spike
// well above normal riding (~1g at rest, ~2g over bumps). 4g+ is a fall or a
// hit. Privacy by design: samples are processed in memory and never stored or
// sent anywhere — in particular, no speed is recorded.
const IMPACT_G = 4;
// After one trigger, stay quiet so the countdown isn't re-opened by the
// aftershocks of the same incident.
const RETRIGGER_COOLDOWN_MS = 60_000;
const SAMPLE_INTERVAL_MS = 100;

/**
 * Watches the accelerometer while `active` and calls `onImpact` once per
 * suspected crash. Safe to keep mounted; the sensor only runs while active.
 */
export function useCrashDetection(active: boolean, onImpact: () => void): void {
  const lastTrigger = useRef(0);
  const impact = useRef(onImpact);
  impact.current = onImpact;

  useEffect(() => {
    if (!active) return;
    Accelerometer.setUpdateInterval(SAMPLE_INTERVAL_MS);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const g = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();
      if (g >= IMPACT_G && now - lastTrigger.current > RETRIGGER_COOLDOWN_MS) {
        lastTrigger.current = now;
        impact.current();
      }
    });
    return () => sub.remove();
  }, [active]);
}
