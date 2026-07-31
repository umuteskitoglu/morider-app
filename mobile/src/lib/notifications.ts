// Bildirim merkezi client, backed by internal/user's /api/notifications.
//
// Push is the loud half of a notification; this is the durable half. Everything
// the server pushes (except DMs, which live in their own inbox) also leaves a
// row here, so a rider who missed the banner can still find out what happened.

import { api } from '../api/client';

export type AppNotification = {
  id: number;
  /** Matches pkg/notify.Kind — see lib/notificationRoute for the screen mapping. */
  type: string;
  actor_id: number | null;
  actor_name: string;
  actor_avatar: string;
  entity_id: number | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
  /** How many events folded into this row: "Ali ve 4 kişi". */
  event_count: number;
  read: boolean;
  created_at: string;
};

/** One page of the list. Pass the oldest id you have to load the next page. */
export async function fetchNotifications(before?: number): Promise<AppNotification[]> {
  const { data } = await api.get('/api/notifications', { params: before ? { before } : undefined });
  return data?.notifications ?? [];
}

export async function fetchUnreadCount(): Promise<number> {
  const { data } = await api.get('/api/notifications/unread-count');
  return data?.unread_count ?? 0;
}

export async function markNotificationRead(id: number): Promise<void> {
  await api.post(`/api/notifications/${id}/read`);
}

// Clears every unread notification about one thing. This is what a tapped push
// calls: the push payload carries no notification id (with fan-out the row id
// differs per recipient), so we clear by what the notification pointed at.
export async function markNotificationsReadByEntity(type: string, entityId: number): Promise<void> {
  await api.post('/api/notifications/read', { type, entity_id: entityId });
}

export async function markAllNotificationsRead(): Promise<void> {
  await api.post('/api/notifications/read-all');
}
