import { registerRootComponent } from 'expo';
import { registerGlobals } from '@livekit/react-native';

import App from './App';

// LiveKit needs its WebRTC globals installed before any room is created. Do it
// once at startup, before the app renders.
registerGlobals();

registerRootComponent(App);
