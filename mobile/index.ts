import { registerRootComponent } from 'expo';
import { registerGlobals } from '@livekit/react-native';

import App from './App';
// Registers the background ride-location TaskManager task at startup, before any
// ride starts it. The import side-effect is the registration.
import './src/lib/backgroundLocation';

// LiveKit needs its WebRTC globals installed before any room is created. Do it
// once at startup, before the app renders.
registerGlobals();

// FCM requires a background handler to be registered outside of any React
// component, or it warns and drops data-only messages that arrive while the app
// is killed. It deliberately does nothing: there is no UI in this context, and a
// tap is handled by getInitialNotification on the next launch (see lib/push).
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const messaging = require('@react-native-firebase/messaging').default;
  messaging().setBackgroundMessageHandler(async () => {});
} catch {
  // Native module absent (Expo Go / web sandbox) — nothing to register.
}

registerRootComponent(App);
