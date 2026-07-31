import 'react-native-gesture-handler';
import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/store/auth';
import { ChatUnreadProvider } from './src/store/chatUnread';
import { NotificationsProvider } from './src/store/notifications';
import { BlockedUsersProvider } from './src/store/blockedUsers';
import RootNavigator from './src/navigation/RootNavigator';
import SplashOverlay from './src/components/SplashOverlay';
import ErrorBoundary from './src/components/ErrorBoundary';

export default function App() {
  // The animated engine-rev splash plays once per cold start, then unmounts.
  const [splashDone, setSplashDone] = useState(false);

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <AuthProvider>
            <ChatUnreadProvider>
              <NotificationsProvider>
                <BlockedUsersProvider>
                  <StatusBar style="light" />
                  <RootNavigator />
                  {!splashDone && <SplashOverlay onFinish={() => setSplashDone(true)} />}
                </BlockedUsersProvider>
              </NotificationsProvider>
            </ChatUnreadProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
