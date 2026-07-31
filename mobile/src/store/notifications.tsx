// Tracks the unread notification count so the header bell can badge without
// every screen polling the list. Mirrors chatUnread, but polls the cheap
// /unread-count endpoint rather than fetching rows nobody is looking at.
//
// The list itself lives in NotificationsScreen — this provider owns the counter
// and nothing else.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from './auth';
import {
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '../lib/notifications';

const POLL_MS = 30000;

type NotificationsState = {
  unreadCount: number;
  refresh: () => Promise<void>;
  /** Clears one notification and decrements the badge optimistically. */
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Bumps the badge immediately when a push arrives in the foreground, instead
   *  of leaving it stale until the next poll. */
  bumpUnread: () => void;
};

const NotificationsContext = createContext<NotificationsState | undefined>(undefined);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setUnreadCount(await fetchUnreadCount());
    } catch {
      // best effort — keep whatever we had
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setUnreadCount(0);
      return;
    }
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [token, refresh]);

  const markRead = useCallback(async (id: number) => {
    setUnreadCount((n) => Math.max(0, n - 1));
    try {
      await markNotificationRead(id);
    } catch {
      // Already read, or gone. The next poll reconciles the count.
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setUnreadCount(0);
    try {
      await markAllNotificationsRead();
    } catch {
      // best effort — the next poll reconciles the count
    }
  }, []);

  const bumpUnread = useCallback(() => setUnreadCount((n) => n + 1), []);

  const value = useMemo<NotificationsState>(
    () => ({ unreadCount, refresh, markRead, markAllRead, bumpUnread }),
    [unreadCount, refresh, markRead, markAllRead, bumpUnread],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationsProvider');
  }
  return ctx;
}
