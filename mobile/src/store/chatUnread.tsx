// Tracks unread-conversation count across the app so the bottom tab bar can
// show a badge without every screen re-fetching the DM inbox independently.
//
// The list is cached: opening the Sohbet tab in a tunnel used to show an empty
// inbox and "henüz mesajın yok", which reads as data loss rather than as a
// missing connection.
import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';

import { useAuth } from './auth';
import { ConversationItem, fetchConversations } from '../lib/chat';
import { useCachedState } from '../lib/offlineCache';

const POLL_MS = 20000;

type ChatUnreadState = {
  conversations: ConversationItem[];
  // Number of distinct conversations with at least one unread message — e.g.
  // 3 riders messaged you shows "3", regardless of how many messages each sent.
  unreadCount: number;
  refresh: () => Promise<void>;
};

const ChatUnreadContext = createContext<ChatUnreadState | undefined>(undefined);

export function ChatUnreadProvider({ children }: { children: React.ReactNode }) {
  const { token, loading: authLoading } = useAuth();
  const [conversations, setConversations] = useCachedState<ConversationItem[]>('conversations', []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setConversations(await fetchConversations());
    } catch {
      // best effort — keep whatever we had (cached inbox included)
    }
  }, [token, setConversations]);

  useEffect(() => {
    // The token is null for the moment it takes to read it back from storage.
    // Clearing here would be a write, and a write beats the cache read to the
    // punch — every cold start would blank the saved inbox before it loaded.
    if (authLoading) return;
    if (!token) {
      setConversations([]);
      return;
    }
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [token, authLoading, refresh, setConversations]);

  const unreadCount = useMemo(
    () => conversations.filter((c) => c.unread_count > 0).length,
    [conversations],
  );

  const value = useMemo<ChatUnreadState>(
    () => ({ conversations, unreadCount, refresh }),
    [conversations, unreadCount, refresh],
  );

  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

export function useChatUnread(): ChatUnreadState {
  const ctx = useContext(ChatUnreadContext);
  if (!ctx) {
    throw new Error('useChatUnread must be used within ChatUnreadProvider');
  }
  return ctx;
}
