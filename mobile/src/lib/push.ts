// Remote push via Firebase Cloud Messaging (@react-native-firebase).
//
// Two jobs: register this device's FCM token with the backend, and route a
// tapped notification to the screen it is about. Best effort throughout — any
// failure is silently ignored. FCM is unavailable under Expo Go and the Expo
// web/dev sandbox, so this no-ops there; it works in development/production
// (EAS) builds that include the Firebase config files.
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import { api } from '../api/client';
import { openNotification } from './notificationRoute';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Loaded lazily via require so the bundle still builds where the native module
// is absent (and so type-checking doesn't require the package to be installed).
function messagingModule(): any | null {
  if (isExpoGo) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@react-native-firebase/messaging').default;
  } catch {
    return null;
  }
}

// The onTokenRefresh unsubscribe, held at module scope. registerForPush runs on
// every auth-token change, so without this every sign-out/sign-in cycle left
// another live listener behind, each one re-POSTing the same token.
let tokenRefreshUnsub: (() => void) | null = null;

// The last FCM token we registered, so sign-out can deregister it.
let currentToken: string | null = null;

export async function registerForPush(): Promise<void> {
  const messaging = messagingModule();
  if (!messaging) return;

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
      currentToken = token;
      await api.post('/api/users/push-token', { token, platform: Platform.OS });
    }

    // Keep the backend in sync if FCM rotates the token while installed.
    tokenRefreshUnsub?.();
    tokenRefreshUnsub =
      messaging().onTokenRefresh?.((next: string) => {
        currentToken = next;
        api.post('/api/users/push-token', { token: next, platform: Platform.OS }).catch(() => {});
      }) ?? null;
  } catch {
    // best effort — no push, no problem
  }
}

// unregisterPushToken drops this device from the signed-out account.
//
// Without it the push_tokens row keeps pointing at the previous user until they
// next sign in somewhere — so the next person to use the phone would receive the
// previous rider's notifications.
export async function unregisterPushToken(): Promise<void> {
  const token = currentToken;
  currentToken = null;
  tokenRefreshUnsub?.();
  tokenRefreshUnsub = null;
  if (!token) return;
  try {
    await api.delete('/api/users/push-token', { data: { token } });
  } catch {
    // best effort — signing out must never be blocked by this
  }
  try {
    messagingModule()?.().deleteToken?.();
  } catch {
    // ditto
  }
}

/**
 * installPushHandlers wires tapped notifications to lib/notificationRoute and
 * returns a combined unsubscribe.
 *
 * Three arrival paths have to be covered, and they are genuinely different:
 * getInitialNotification (app was killed), onNotificationOpenedApp (app was
 * backgrounded) and onMessage (app is in the foreground, where the OS shows
 * nothing and there is no tap at all).
 *
 * onForeground lets the caller show its own banner and bump the unread badge.
 */
export function installPushHandlers(onForeground?: (data: Record<string, unknown>, title: string, body: string) => void): () => void {
  const messaging = messagingModule();
  if (!messaging) return () => {};

  const unsubs: Array<() => void> = [];
  try {
    // App was killed and launched by tapping the notification.
    messaging()
      .getInitialNotification()
      .then((msg: any) => {
        if (msg?.data) openNotification(msg.data);
      })
      .catch(() => {});

    // App was backgrounded and brought forward by a tap.
    const openedUnsub = messaging().onNotificationOpenedApp((msg: any) => {
      if (msg?.data) openNotification(msg.data);
    });
    if (typeof openedUnsub === 'function') unsubs.push(openedUnsub);

    // App is already open: nothing is shown by the OS, so the caller draws it.
    const messageUnsub = messaging().onMessage((msg: any) => {
      onForeground?.(
        msg?.data ?? {},
        msg?.notification?.title ?? '',
        msg?.notification?.body ?? '',
      );
    });
    if (typeof messageUnsub === 'function') unsubs.push(messageUnsub);
  } catch {
    // best effort
  }

  return () => unsubs.forEach((fn) => fn());
}
