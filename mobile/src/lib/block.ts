// Block client: REST wrappers for /api/blocks, mirroring the style of chat.ts
// and FollowButton's direct api.put/delete calls.

import { api } from '../api/client';

export type BlockedUser = { id: number; name: string; avatar_url: string };

export async function blockUser(userId: number): Promise<void> {
  await api.put(`/api/blocks/${userId}`);
}

export async function unblockUser(userId: number): Promise<void> {
  await api.delete(`/api/blocks/${userId}`);
}

export async function fetchBlockStatus(userId: number): Promise<{ blocking: boolean; blocked_by: boolean }> {
  const { data } = await api.get(`/api/blocks/status/${userId}`);
  return { blocking: data?.blocking ?? false, blocked_by: data?.blocked_by ?? false };
}

export async function fetchBlockedUsers(): Promise<BlockedUser[]> {
  const { data } = await api.get('/api/blocks');
  return data?.users ?? [];
}
