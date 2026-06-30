// Local (on-device) reminders for time-based maintenance items (e.g. "every 12
// months"). Distance-based intervals can't be scheduled by date — they surface
// via the in-app status colour instead. Same Expo Go guard as garageReminders:
// under Expo Go the module no-ops; reminders work in development/production builds.
import type * as NotificationsModule from 'expo-notifications';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { MaintenanceItem } from './garage';

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

// Days before a due date to fire a reminder (at 09:00 local).
const OFFSETS_DAYS = [7, 1];

// Per account + bike, so switching users/bikes can't cancel another's reminders.
function storeKey(userId: number, bikeId: number): string {
  return `morider.maint.reminders.${userId}.${bikeId}`;
}

type PendingReminder = { body: string; fireAt: Date; itemId: number };

// Pure planning pass: which reminders should exist for these schedules now.
// Only time-based items (a known due-in-days) can be date-scheduled.
function collectPending(bikeName: string, items: MaintenanceItem[]): PendingReminder[] {
  const out: PendingReminder[] = [];
  for (const m of items) {
    if (m.due_in_days == null) continue;
    // Resolve the due date from the whole-day countdown the backend returns.
    const due = new Date();
    due.setHours(0, 0, 0, 0);
    due.setDate(due.getDate() + m.due_in_days);
    for (const off of OFFSETS_DAYS) {
      const fireAt = new Date(due);
      fireAt.setDate(fireAt.getDate() - off);
      fireAt.setHours(9, 0, 0, 0);
      if (fireAt.getTime() <= Date.now() + 5_000) continue; // already passed
      out.push({ body: reminderBody(bikeName, m.item, off), fireAt, itemId: m.id });
    }
  }
  return out;
}

function reminderBody(bikeName: string, item: string, days: number): string {
  if (days <= 1) return `${bikeName}: ${item} bakımı yarın için planlı`;
  return `${bikeName}: ${item} bakımına ${days} gün kaldı`;
}

async function ensureAndroidChannel(N: typeof NotificationsModule): Promise<void> {
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync('maintenance', {
      name: 'Bakım hatırlatmaları',
      importance: N.AndroidImportance.HIGH,
    });
  }
}

/**
 * Re-syncs one bike's time-based maintenance reminders: cancels the previous
 * batch, then schedules 7-gün ve 1-gün kala bildirimleri for each future due
 * date. Call after the maintenance list loads or changes.
 */
export async function syncMaintenanceReminders(
  bikeId: number,
  bikeName: string,
  items: MaintenanceItem[],
  userId: number,
): Promise<void> {
  const N = getNotifications();
  if (!N) return;
  const key = storeKey(userId, bikeId);

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

  const pending = collectPending(bikeName, items);
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
          title: 'Morider Bakım',
          body: r.body,
          data: { bikeId, itemId: r.itemId },
        },
        trigger: {
          type: N.SchedulableTriggerInputTypes.DATE,
          date: r.fireAt,
          channelId: 'maintenance',
        },
      });
      ids.push(id);
    } catch {
      // best effort — skip this reminder
    }
  }
  await AsyncStorage.setItem(key, JSON.stringify(ids));
}
