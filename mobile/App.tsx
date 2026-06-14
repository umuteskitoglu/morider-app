import 'react-native-gesture-handler';
import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/store/auth';
import RootNavigator from './src/navigation/RootNavigator';
import SplashOverlay from './src/components/SplashOverlay';

export default function App() {
  // The animated engine-rev splash plays once per cold start, then unmounts.
  const [splashDone, setSplashDone] = useState(false);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <RootNavigator />
          {!splashDone && <SplashOverlay onFinish={() => setSplashDone(true)} />}
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
