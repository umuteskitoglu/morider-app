import { registerRootComponent } from 'expo';
import { registerGlobals } from '@livekit/react-native';

import App from './App';
// Registers the background ride-location TaskManager task at startup, before any
// ride starts it. The import side-effect is the registration.
import './src/lib/backgroundLocation';
// Configures the shared audio session (ducking, background playback) before
// anything plays — splash sound, TTS voice guidance, etc.
import './src/lib/audio';

// LiveKit needs its WebRTC globals installed before any room is created. Do it
// once at startup, before the app renders.
registerGlobals();

registerRootComponent(App);
