// Without this, the app's audio session defaults to exclusive focus: starting
// turn-by-turn voice guidance (expo-speech) pauses whatever the rider has
// playing in Spotify/YouTube Music and doesn't hand focus back afterwards, so
// they can't resume it without leaving the app. 'duckOthers' makes voice
// instructions lower other apps' volume instead of stopping them, like Google
// Maps/Waze do.
//
// Deliberately NOT run at app launch: activating the audio session was a
// suspect in launch crashes, and nothing needs it until a ride starts. Call
// configureAudioSession() when recording/navigation begins — it's idempotent,
// lazily loads expo-audio and swallows every failure, so a broken native audio
// module costs only the ducking behavior, never the app.
let configured = false;

export function configureAudioSession(): void {
  if (configured) return;
  configured = true;
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
}
