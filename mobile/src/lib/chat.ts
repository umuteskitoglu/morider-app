// Chat client: global community room + one-to-one direct messages, backed by
// internal/chat. REST wrappers plus a helper to build the token-authenticated
// WebSocket URL (browsers/RN can't set headers on a WebSocket, so the JWT rides
// in the query string, matching the event-chat pattern).

import AsyncStorage from '@react-native-async-storage/async-storage';

import { api, apiBaseURL, TOKEN_KEY } from '../api/client';

export type GlobalMsg = {
  id: number;
  user_id: number;
  name: string;
  avatar_url: string;
  body: string;
  created_at: string;
};

export type DmMsg = {
  id: number;
  conversation_id: number;
  sender_id: number;
  name: string;
  body: string;
  lat?: number;
  lon?: number;
  created_at: string;
};

export type ConversationUser = { id: number; name: string; avatar_url: string };

export type ConversationItem = {
  conversation_id: number;
  other_user: ConversationUser;
  status: 'pending' | 'accepted' | 'declined';
  is_request: boolean;
  last_message: { body: string; sender_id: number; created_at: string } | null;
  unread_count: number;
};

// A slow-mode control frame the global-chat WebSocket sends when a message is
// rejected for being too soon after the previous one.
export type SlowmodeFrame = { type: 'slowmode'; retry_after_ms: number };

// buildWsUrl turns an API path into a ws(s):// URL carrying the auth token.
export async function buildWsUrl(path: string): Promise<string | null> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  return `${apiBaseURL().replace(/^http/, 'ws')}${path}?token=${token}`;
}

export async function fetchGlobalMessages(before?: number): Promise<GlobalMsg[]> {
  const { data } = await api.get('/api/chat/global/messages', { params: before ? { before } : undefined });
  return data?.messages ?? [];
}

export async function fetchConversations(): Promise<ConversationItem[]> {
  const { data } = await api.get('/api/dm');
  return data?.conversations ?? [];
}

// startConversation finds or creates the conversation with a user and returns its
// id (plus status: 'accepted' when mutual-follow, else 'pending').
export async function startConversation(userId: number): Promise<{ conversation_id: number; status: string }> {
  const { data } = await api.post('/api/dm', { user_id: userId });
  return data;
}

export async function fetchDmMessages(convId: number, before?: number): Promise<{ messages: DmMsg[]; status: string }> {
  const { data } = await api.get(`/api/dm/${convId}/messages`, { params: before ? { before } : undefined });
  return { messages: data?.messages ?? [], status: data?.status ?? 'accepted' };
}

export async function acceptConversation(convId: number): Promise<void> {
  await api.post(`/api/dm/${convId}/accept`);
}

export async function declineConversation(convId: number): Promise<void> {
  await api.post(`/api/dm/${convId}/decline`);
}
