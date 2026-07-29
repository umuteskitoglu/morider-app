import {
  GoogleSignin,
  isErrorWithCode,
  statusCodes,
} from '@react-native-google-signin/google-signin';

/**
 * Google Sign-In wiring, kept out of the auth store so the store stays about
 * session state and this file stays about Google's SDK.
 *
 * Client ids come from the Google Cloud project behind Firebase:
 *   - iosClientId  — the iOS OAuth client (CLIENT_ID in GoogleService-Info.plist)
 *   - webClientId  — the *Web* OAuth client
 *
 * The web client id is not optional on Android despite the name: Android mints
 * its ID token with the **web** client as the audience, while iOS uses the iOS
 * client. That is why the backend's GOOGLE_CLIENT_IDS must list both — a token
 * from one platform would otherwise be rejected as "issued for a different
 * application".
 */
const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';

/**
 * Whether the app was built with Google credentials. The sign-in button is
 * hidden when false, which is better than showing a button that always fails.
 */
export const googleSignInAvailable = webClientId !== '' || iosClientId !== '';

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: webClientId || undefined,
    iosClientId: iosClientId || undefined,
    // We only need identity, not API access on the user's behalf, so no
    // offline access and no server auth code — the ID token is enough and is
    // the only thing that leaves the device.
    offlineAccess: false,
    scopes: ['email', 'profile'],
  });
  configured = true;
}

/** Raised when the user backs out of the Google sheet. Not an error to report. */
export class GoogleSignInCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'GoogleSignInCancelled';
  }
}

/**
 * Runs the native Google flow and returns the ID token to send to our backend.
 *
 * The token is the only credential that leaves the device; the backend verifies
 * it against Google's public keys, so nothing here is trusted on the server.
 */
export async function getGoogleIdToken(): Promise<string> {
  ensureConfigured();

  // Android only; resolves immediately on iOS. Surfaces a fixable device issue
  // (outdated/missing Play Services) instead of an opaque sign-in failure.
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  // Sign out first so the account picker always appears. Without this, a device
  // with a cached session silently reuses the previous account, which is
  // actively confusing on a shared phone.
  try {
    await GoogleSignin.signOut();
  } catch {
    // No previous session; nothing to do.
  }

  let response;
  try {
    response = await GoogleSignin.signIn();
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new GoogleSignInCancelled();
    }
    throw err;
  }

  if (response.type === 'cancelled') {
    throw new GoogleSignInCancelled();
  }

  const idToken = response.data.idToken;
  if (!idToken) {
    // Almost always a configuration problem: a missing/incorrect webClientId
    // leaves the native SDK with nothing to sign an ID token with.
    throw new Error(
      'Google kimlik doğrulaması eksik döndü. Uygulama yapılandırmasını kontrol edin.',
    );
  }
  return idToken;
}

/** Clears the native Google session so the next sign-in starts clean. */
export async function googleSignOut(): Promise<void> {
  if (!googleSignInAvailable) return;
  try {
    ensureConfigured();
    await GoogleSignin.signOut();
  } catch {
    // Signing out of Google is best effort; our own session is already gone.
  }
}
