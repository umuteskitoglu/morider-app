import { useEffect, useRef, useState } from 'react';
import { Accelerometer } from 'expo-sensors';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lean (yatma) angle from the phone's gravity vector. The phone is assumed
// mounted roughly upright on the bars; the lateral tilt of the gravity vector
// tracks how far the bike is leaned over. Caveat: in a steady coordinated turn
// the centripetal force adds to gravity, so a bare accelerometer reads a bit
// *less* than the true lean — good enough for a live "yaklaşık" gauge.
//
// A one-tap calibration ("dik konumu sıfırla") captures the upright reading as
// an offset so the gauge zeroes out for the rider's specific mount angle.
const OFFSET_KEY = '@morider/leanOffset';
const SAMPLE_INTERVAL_MS = 80;
// Exponential moving average factor — lower = smoother but laggier.
const EMA_ALPHA = 0.25;

// Raw roll from the gravity vector, in degrees: how far the device's lateral
// (x) axis dips from horizontal. Standard tilt-sensing "roll" — independent of
// how far the phone is pitched back toward the rider, so calibration only has
// to cancel a constant offset. Assumes a portrait mount (x ≈ bike's left/right).
function rollDeg(x: number, y: number, z: number): number {
  return (Math.atan2(x, Math.hypot(y, z)) * 180) / Math.PI;
}

export type LeanReading = {
  lean: number; // degrees, right-positive, relative to the calibrated upright
  maxLean: number; // peak |lean| seen since mount, in degrees
  calibrate: () => void;
};

/**
 * Streams the bike's lean angle while `active`. Sensor only runs when active
 * to spare the battery. Returns the live angle, the running peak, and a
 * calibrate() that re-zeroes against the current orientation.
 */
export function useLeanAngle(active: boolean): LeanReading {
  const [lean, setLean] = useState(0);
  const [maxLean, setMaxLean] = useState(0);
  const offset = useRef(0);
  const filtered = useRef(0);
  const rawRoll = useRef(0);
  const primed = useRef(false);

  // Load any saved calibration once on mount.
  useEffect(() => {
    AsyncStorage.getItem(OFFSET_KEY)
      .then((v) => {
        if (v != null) offset.current = parseFloat(v) || 0;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return;
    Accelerometer.setUpdateInterval(SAMPLE_INTERVAL_MS);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const raw = rollDeg(x, y, z);
      rawRoll.current = raw;
      // Smooth the raw signal; seed the filter on the first sample so it
      // doesn't ramp up from zero.
      filtered.current = primed.current ? filtered.current + EMA_ALPHA * (raw - filtered.current) : raw;
      primed.current = true;
      const value = filtered.current - offset.current;
      setLean(value);
      setMaxLean((m) => (Math.abs(value) > m ? Math.abs(value) : m));
    });
    return () => sub.remove();
  }, [active]);

  function calibrate() {
    offset.current = filtered.current;
    setLean(0);
    setMaxLean(0);
    AsyncStorage.setItem(OFFSET_KEY, String(offset.current)).catch(() => {});
  }

  return { lean, maxLean, calibrate };
}
