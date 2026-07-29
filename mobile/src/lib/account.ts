import { api } from '../api/client';

/**
 * Permanently deletes the signed-in rider's account.
 *
 * Required by App Store Review Guideline 5.1.1(v) and Google Play's data
 * deletion policy: an app that creates accounts must let people delete them
 * from inside the app, not by emailing support.
 *
 * The server cascade removes rides, telemetry, routes, posts, garage, rewards,
 * follows and blocks. There is no undo, so the caller must have confirmed
 * explicitly before getting here.
 */
export async function deleteAccount(): Promise<void> {
  await api.delete('/api/users/me');
}
