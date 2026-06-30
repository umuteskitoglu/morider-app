// Remote push registration via Firebase Cloud Messaging (@react-native-firebase).
// Asks for permission, fetches the device's FCM token and registers it with the
// backend so other riders' actions (e.g. a challenge invite) can notify this
// device. Best effort: any failure is silently ignored. FCM is unavailable under
// Expo Go and the Expo web/dev sandbox, so this no-ops there — it works in
// development/production (EAS) builds that include the Firebase config files.
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import { api } from '../api/client';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export async function registerForPush(): Promise<void> {
  if (isExpoGo) return;

  // Loaded lazily via require so the bundle still builds where the native module
  // is absent (and so type-checking doesn't require the package to be installed).
  let messaging: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    messaging = require('@react-native-firebase/messaging').default;
  } catch {
    return;
  }

  try {
    // iOS: ensure the device is registered with APNs before requesting a token.
    if (Platform.OS === 'ios' && messaging().registerDeviceForRemoteMessages) {
      await messaging().registerDeviceForRemoteMessages();
    }

    const status = await messaging().requestPermission();
    // 1 = AUTHORIZED, 2 = PROVISIONAL.
    const granted = status === 1 || status === 2;
    if (!granted) return;

    const token: string | undefined = await messaging().getToken();
    if (token) {
      await api.post('/api/users/push-token', { token, platform: Platform.OS });
    }

    // Keep the backend in sync if FCM rotates the token while installed.
    messaging().onTokenRefresh?.((next: string) => {
      api.post('/api/users/push-token', { token: next, platform: Platform.OS }).catch(() => {});
    });
  } catch {
    // best effort — no push, no problem
  }
}
