// The one place that knows how a notification becomes a screen.
//
// Four callers share it — a tapped FCM push (cold start, background, and the
// foreground banner), a row in the notification center, and the response
// listener for local reminders — so none of them can drift apart from the
// others or from what the backend sends.
//
// Routing goes through navigationRef rather than the `linking` config on
// purpose: linking covers only 4 of the kinds below, deep-link params arrive as
// strings (every screen would need a coercion it does not have today), and
// Linking.openURL from a notification callback is unreliable on cold start. The
// linking config keeps doing its real job — external morider:// share links —
// untouched.

import { navigateNested } from '../navigation/navigationRef';
import { markNotificationsReadByEntity } from './notifications';

/** A push data payload (FCM stringifies every value) or a notification row. */
export type NotifData = Record<string, unknown> | undefined;

type Target = { tab: string; screen: string; params?: Record<string, unknown> };

// FCM delivers every data value as a string; the notification center hands us
// real numbers. Both have to work.
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// targetFor maps a notification's type + ids onto a screen. An unknown type
// returns null, which means "just open the app" — a new backend kind reaching an
// old client must not crash it.
export function targetFor(data: NotifData): Target | null {
  const entity = num(data?.entity_id);
  switch (str(data?.type)) {
    case 'dm':
      return { tab: 'Chat', screen: 'ChatThread', params: { conversationId: num(data?.conversation_id) ?? entity } };
    case 'community_post': {
      // The post id lets the tap land on the broadcast itself; without it we can
      // only open the community.
      const postId = num(data?.post_id);
      return postId
        ? { tab: 'Chat', screen: 'CommunityComments', params: { postId } }
        : { tab: 'Chat', screen: 'CommunityDetail', params: { id: num(data?.community_id) ?? entity } };
    }
    case 'community_join_request':
    case 'community_approved':
      return { tab: 'Chat', screen: 'CommunityDetail', params: { id: num(data?.community_id) ?? entity } };
    case 'challenge_invite':
      return {
        tab: 'Profile',
        screen: 'ChallengeDetail',
        params: { id: num(data?.challenge_id) ?? entity, name: 'Meydan Okuma' },
      };
    case 'sos':
      // No SOS screen exists; the ride surface is where a responder acts.
      return { tab: 'Ride', screen: 'RideMain' };
    case 'follow':
      return { tab: 'Profile', screen: 'UserProfile', params: { userId: num(data?.user_id) ?? entity, name: '' } };
    case 'post_like':
    case 'post_comment':
      return { tab: 'Feed', screen: 'Comments', params: { postId: entity } };
    case 'segment_kom':
      return { tab: 'Profile', screen: 'SegmentDetail', params: { id: entity, name: 'Kapışma' } };
    // Local reminders scheduled by lib/{event,garage,maintenance}Reminders.
    case 'event_reminder':
      return { tab: 'Events', screen: 'EventDetail', params: { code: str(data?.code) } };
    case 'garage_reminder':
      return { tab: 'Profile', screen: 'BikeDetail', params: { id: num(data?.motoId), name: 'Motor' } };
    case 'maintenance_reminder':
      return { tab: 'Profile', screen: 'BikeDetail', params: { id: num(data?.bikeId), name: 'Motor' } };
    default:
      return null;
  }
}

// A route that arrived before the navigation container was ready. This is not a
// rare edge: on a cold start the auth provider hydrates from AsyncStorage first,
// and RootNavigator renders a spinner *instead of* NavigationContainer until it
// finishes — so a tap handled during that window would otherwise be dropped.
let pending: Target | null = null;

/** Navigate to whatever a notification points at, now or as soon as possible. */
export function openNotification(data: NotifData): void {
  const target = targetFor(data);
  if (!target) return;

  // Opening the thing is as good as reading about it, so clear the bell for it.
  const type = str(data?.type);
  const entity = num(data?.entity_id);
  if (type && entity) {
    markNotificationsReadByEntity(type, entity).catch(() => {});
  }

  if (!navigate(target)) pending = target;
}

/** Retry a queued route. Safe to call repeatedly; a no-op when nothing is queued. */
export function flushPendingRoute(): void {
  if (!pending) return;
  const target = pending;
  if (navigate(target)) pending = null;
}

function navigate(t: Target): boolean {
  return navigateNested(t.tab, t.screen, t.params);
}

/**
 * installLocalNotificationHandler routes taps on the *local* reminders
 * scheduled by lib/{event,garage,maintenance}Reminders, which until now opened
 * the app and left the rider to find the thing themselves.
 *
 * Returns an unsubscribe. Safe to call where expo-notifications is unavailable.
 */
export function installLocalNotificationHandler(): () => void {
  let N: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    N = require('expo-notifications');
  } catch {
    return () => {};
  }
  try {
    // A reminder tapped while the app was killed.
    N.getLastNotificationResponseAsync?.()
      .then((res: any) => {
        const data = res?.notification?.request?.content?.data;
        if (data) openNotification(data);
      })
      .catch(() => {});

    const sub = N.addNotificationResponseReceivedListener((res: any) => {
      const data = res?.notification?.request?.content?.data;
      if (data) openNotification(data);
    });
    return () => sub?.remove?.();
  } catch {
    return () => {};
  }
}
