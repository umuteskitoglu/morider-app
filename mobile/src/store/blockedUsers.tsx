// Tracks the caller's blocked-user ids across the app so chat/map screens can
// hide a blocked rider's content without each screen re-fetching the list.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from './auth';
import { fetchBlockedUsers } from '../lib/block';

type BlockedUsersState = {
  blockedIds: Set<number>;
  isBlocked: (userId: number) => boolean;
  refresh: () => Promise<void>;
};

const BlockedUsersContext = createContext<BlockedUsersState | undefined>(undefined);

export function BlockedUsersProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [blockedIds, setBlockedIds] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const users = await fetchBlockedUsers();
      setBlockedIds(new Set(users.map((u) => u.id)));
    } catch {
      // best effort — keep whatever we had
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setBlockedIds(new Set());
      return;
    }
    refresh();
  }, [token, refresh]);

  const isBlocked = useCallback((userId: number) => blockedIds.has(userId), [blockedIds]);

  const value = useMemo<BlockedUsersState>(
    () => ({ blockedIds, isBlocked, refresh }),
    [blockedIds, isBlocked, refresh],
  );

  return <BlockedUsersContext.Provider value={value}>{children}</BlockedUsersContext.Provider>;
}

export function useBlockedUsers(): BlockedUsersState {
  const ctx = useContext(BlockedUsersContext);
  if (!ctx) {
    throw new Error('useBlockedUsers must be used within BlockedUsersProvider');
  }
  return ctx;
}
