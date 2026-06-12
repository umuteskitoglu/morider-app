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

// Scheduled-id store is per account, so switching users on one device can't
// cancel or leak another account's reminders.
function storeKey(userId: number): string {
  return `morider.garage.reminders.${userId}`;
}

type PendingReminder = { body: string; fireAt: Date; motoId: number; doc: string };

// Pure planning pass: which reminders should exist for this garage right now.
function collectPending(motos: Motorcycle[]): PendingReminder[] {
  const out: PendingReminder[] = [];
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
        out.push({ body: reminderBody(moto.name, DOC_LABELS[key], off), fireAt, motoId: moto.id, doc: key });
      }
    }
  }
  return out;
}

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
export async function syncGarageReminders(motos: Motorcycle[], userId: number): Promise<void> {
  const N = getNotifications();
  if (!N) return;
  const key = storeKey(userId);

  // Cancel the previous batch (best effort).
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      await Promise.all(ids.map((id) => N.cancelScheduledNotificationAsync(id).catch(() => {})));
    }
  } catch {
    // ignore
  }

  // Nothing to schedule (empty garage / no future dates) → don't bother the
  // user with a permission prompt.
  const pending = collectPending(motos);
  if (pending.length === 0) {
    await AsyncStorage.removeItem(key);
    return;
  }

  const perm = await N.getPermissionsAsync();
  if (!perm.granted) {
    const req = await N.requestPermissionsAsync();
    if (!req.granted) {
      await AsyncStorage.removeItem(key);
      return;
    }
  }
  await ensureAndroidChannel(N);

  const ids: string[] = [];
  for (const r of pending) {
    try {
      const id = await N.scheduleNotificationAsync({
        content: {
          title: 'Morider Garaj',
          body: r.body,
          data: { motoId: r.motoId, doc: r.doc },
        },
        trigger: {
          type: N.SchedulableTriggerInputTypes.DATE,
          date: r.fireAt,
          channelId: 'garage',
        },
      });
      ids.push(id);
    } catch {
      // best effort — skip this reminder
    }
  }
  await AsyncStorage.setItem(key, JSON.stringify(ids));
}
