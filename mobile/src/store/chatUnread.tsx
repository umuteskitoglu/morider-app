// Tracks unread-conversation count across the app so the bottom tab bar can
// show a badge without every screen re-fetching the DM inbox independently.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from './auth';
import { ConversationItem, fetchConversations } from '../lib/chat';

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
  const { token } = useAuth();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setConversations(await fetchConversations());
    } catch {
      // best effort — keep whatever we had
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setConversations([]);
      return;
    }
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [token, refresh]);

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
