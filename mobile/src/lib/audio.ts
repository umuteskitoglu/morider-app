// Without this, the app's audio session defaults to exclusive focus: starting
// turn-by-turn voice guidance (expo-speech) or the splash sound pauses
// whatever the rider has playing in Spotify/YouTube Music and doesn't hand
// focus back afterwards, so they can't resume it without leaving the app.
// 'duckOthers' makes voice instructions lower other apps' volume instead of
// stopping them, like Google Maps/Waze do.
//
// This runs at import time, before the app has rendered anything (imported as
// a side effect from index.ts) — loaded lazily via require and guarded, like
// the FCM setup in push.ts, so a missing/mis-linked native audio module can
// never crash the app on launch instead of just skipping audio-session setup.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setAudioModeAsync } = require('expo-audio');
  setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'duckOthers',
  }).catch(() => {});
} catch {
  // best effort — no audio session config, no crash
}
