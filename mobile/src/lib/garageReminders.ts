// Local (on-device) reminders for garage document expiries (trafik sigortası,
// muayene, kasko). Same Expo Go guard as eventReminders: under Expo Go the
// module no-ops; reminders work in development/production builds.
import type * as NotificationsModule from 'expo-notifications';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DOC_KEYS, DOC_LABELS, daysLeft, Motorcycle } from './garage';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

let cached: typeof NotificationsModule | null = null;
function getNotifications(): typeof NotificationsModule | null {
  if (isExpoGo) return null;
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('expo-notifications') as typeof NotificationsModule;
  }
  return cached;
}

// Days before an expiry to fire a reminder (at 09:00 local).
const OFFSETS_DAYS = [7, 1];
const STORE_KEY = 'morider.garage.reminders';

async function ensureAndroidChannel(N: typeof NotificationsModule): Promise<void> {
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync('garage', {
      name: 'Belge hatırlatmaları',
      importance: N.AndroidImportance.HIGH,
    });
  }
}

function reminderBody(motoName: string, docLabel: string, days: number): string {
  if (days <= 1) return `${motoName}: ${docLabel} yarın doluyor!`;
  return `${motoName}: ${docLabel} bitimine ${days} gün kaldı`;
}

/**
 * Re-syncs every garage reminder with the given list: cancels the previously
 * scheduled ones, then schedules 7-gün ve 1-gün kala bildirimleri for each
 * future expiry date. Call after the garage list loads or changes.
 */
export async function syncGarageReminders(motos: Motorcycle[]): Promise<void> {
  const N = getNotifications();
  if (!N) return;

  // Cancel the previous batch (best effort).
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      await Promise.all(ids.map((id) => N.cancelScheduledNotificationAsync(id).catch(() => {})));
    }
  } catch {
    // ignore
  }

  const perm = await N.getPermissionsAsync();
  if (!perm.granted) {
    const req = await N.requestPermissionsAsync();
    if (!req.granted) {
      await AsyncStorage.removeItem(STORE_KEY);
      return;
    }
  }
  await ensureAndroidChannel(N);

  const ids: string[] = [];
  for (const moto of motos) {
    for (const key of DOC_KEYS) {
      const dateISO = moto[key];
      const left = daysLeft(dateISO);
      if (left == null) continue;
      for (const off of OFFSETS_DAYS) {
        if (left < off) continue; // that reminder moment already passed
        const fireAt = new Date(`${dateISO}T09:00:00`);
        fireAt.setDate(fireAt.getDate() - off);
        if (fireAt.getTime() <= Date.now() + 5_000) continue;
        try {
          const id = await N.scheduleNotificationAsync({
            content: {
              title: 'Morider Garaj',
              body: reminderBody(moto.name, DOC_LABELS[key], off),
              data: { motoId: moto.id, doc: key },
            },
            trigger: {
              type: N.SchedulableTriggerInputTypes.DATE,
              date: fireAt,
              channelId: 'garage',
            },
          });
          ids.push(id);
        } catch {
          // best effort — skip this reminder
        }
      }
    }
  }
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(ids));
}
