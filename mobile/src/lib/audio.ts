import { setAudioModeAsync } from 'expo-audio';

// Without this, the app's audio session defaults to exclusive focus: starting
// turn-by-turn voice guidance (expo-speech) or the splash sound pauses
// whatever the rider has playing in Spotify/YouTube Music and doesn't hand
// focus back afterwards, so they can't resume it without leaving the app.
// 'duckOthers' makes voice instructions lower other apps' volume instead of
// stopping them, like Google Maps/Waze do.
setAudioModeAsync({
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'duckOthers',
}).catch(() => {});
