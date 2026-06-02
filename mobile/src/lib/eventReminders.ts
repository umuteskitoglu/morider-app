// Local (on-device) reminders for planned events. When a rider RSVPs "going"
// (or creates an event), we schedule device notifications ahead of the meet
// time — no backend/push infrastructure needed.
//
// expo-notifications is only loaded outside Expo Go. Under Expo Go the module
// logs noisy "push removed from Expo Go (SDK 53)" errors on import and can't
// deliver reliably anyway, so there we no-op. Reminders work in a development
// or production build.
import type * as NotificationsModule from 'expo-notifications';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Lazily require the native module so it's never evaluated under Expo Go.
let cached: typeof NotificationsModule | null = null;
function getNotifications(): typeof NotificationsModule | null {
  if (isExpoGo) return null;
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('expo-notifications') as typeof NotificationsModule;
    cached.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }
  return cached;
}

// Minutes before the meet time to fire a reminder.
const OFFSETS_MIN = [60, 15, 0];

const keyFor = (code: string) => `morider.reminders.${code}`;

async function ensureAndroidChannel(N: typeof NotificationsModule): Promise<void> {
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync('events', {
      name: 'Etkinlik hatırlatmaları',
      importance: N.AndroidImportance.HIGH,
    });
  }
}

// Ask for notification permission once; returns whether it's granted.
export async function ensureNotificationPermission(): Promise<boolean> {
  const N = getNotifications();
  if (!N) return false;
  const current = await N.getPermissionsAsync();
  if (current.granted) return true;
  const req = await N.requestPermissionsAsync();
  return req.granted;
}

function reminderBody(title: string, offsetMin: number): string {
  if (offsetMin === 0) return `"${title}" buluşma zamanı geldi! 🏍️`;
  if (offsetMin >= 60) return `"${title}" etkinliğine ${offsetMin / 60} saat kaldı`;
  return `"${title}" etkinliğine ${offsetMin} dakika kaldı`;
}

// Schedule (replacing any existing) the reminders for an event. No-ops silently
// in Expo Go or when permission is denied. Past/too-soon offsets are skipped.
export async function scheduleEventReminders(code: string, title: string, meetAtISO: string): Promise<void> {
  await cancelEventReminders(code);

  const N = getNotifications();
  if (!N) return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  await ensureAndroidChannel(N);

  const meet = new Date(meetAtISO).getTime();
  if (Number.isNaN(meet)) return;

  const ids: string[] = [];
  for (const off of OFFSETS_MIN) {
    const fireAt = meet - off * 60_000;
    if (fireAt <= Date.now() + 5_000) continue; // already passed (or too soon)
    const id = await N.scheduleNotificationAsync({
      content: { title: 'Morider Etkinlik', body: reminderBody(title, off), data: { code } },
      trigger: {
        type: N.SchedulableTriggerInputTypes.DATE,
        date: new Date(fireAt),
        channelId: 'events',
      },
    });
    ids.push(id);
  }
  await AsyncStorage.setItem(keyFor(code), JSON.stringify(ids));
}

// Cancel every reminder previously scheduled for an event.
export async function cancelEventReminders(code: string): Promise<void> {
  const N = getNotifications();
  try {
    const raw = await AsyncStorage.getItem(keyFor(code));
    if (raw && N) {
      const ids: string[] = JSON.parse(raw);
      await Promise.all(ids.map((id) => N.cancelScheduledNotificationAsync(id).catch(() => {})));
    }
  } catch {
    // best effort
  } finally {
    await AsyncStorage.removeItem(keyFor(code));
  }
}
