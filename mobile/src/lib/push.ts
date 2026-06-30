// Remote push registration. Asks for permission, fetches the device's Expo push
// token and registers it with the backend so other riders' actions (e.g. a
// challenge invite) can notify this device. Best effort: any failure is silently
// ignored. Remote push tokens are not available under Expo Go, so this no-ops
// there — it works in development/production (EAS) builds.
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import { api } from '../api/client';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export async function registerForPush(): Promise<void> {
  if (isExpoGo) return;
  let N: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    N = require('expo-notifications');
  } catch {
    return;
  }
  try {
    // Show banners while the app is foregrounded.
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    let granted = (await N.getPermissionsAsync()).granted;
    if (!granted) granted = (await N.requestPermissionsAsync()).granted;
    if (!granted) return;

    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync('default', {
        name: 'Bildirimler',
        importance: N.AndroidImportance.HIGH,
      });
    }

    const projectId =
      (Constants as any).expoConfig?.extra?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
    const tokenResp = await N.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const token: string | undefined = tokenResp?.data;
    if (token) {
      await api.post('/api/users/push-token', { token, platform: Platform.OS });
    }
  } catch {
    // best effort — no push, no problem
  }
}
