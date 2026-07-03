// Communities (Topluluk) client: rider clubs where only admins broadcast posts
// and members comment, like and vote. Backed by internal/community; REST
// wrappers in the same style as chat.ts.

import { api } from '../api/client';

export type CommunityRole = 'owner' | 'admin' | 'member' | '';
export type MemberStatus = 'active' | 'pending' | '';
export type CommunityPrivacy = 'public' | 'closed';

export type Community = {
  id: number;
  name: string;
  description: string;
  privacy: CommunityPrivacy;
  avatar_url: string;
  created_by: number;
  created_at: string;
  member_count: number;
  my_role: CommunityRole;
  my_status: MemberStatus;
  pending_count?: number;
};

export type CommunityMember = {
  user_id: number;
  name: string;
  role: CommunityRole;
  status: MemberStatus;
  joined_at: string;
};

export type PollOption = { id: number; label: string; votes: number };

export type Poll = {
  question: string;
  options: PollOption[];
  total_votes: number;
  my_vote: number | null;
};

export type RouteAttachment = { id: number; name: string; distance: number };

export type EventAttachment = { id: number; code: string; title: string; start_at: string };

export type CommunityPost = {
  id: number;
  community_id: number;
  user_id: number;
  author: string;
  body: string;
  pinned: boolean;
  created_at: string;
  photos: string[];
  like_count: number;
  comment_count: number;
  liked: boolean;
  route?: RouteAttachment;
  event?: EventAttachment;
  poll?: Poll;
};

export async function fetchCommunities(opts?: { q?: string; mine?: boolean }): Promise<Community[]> {
  const params: Record<string, string> = {};
  if (opts?.q) params.q = opts.q;
  if (opts?.mine) params.mine = '1';
  const { data } = await api.get('/api/communities', { params });
  return data?.communities ?? [];
}

export async function fetchCommunity(id: number): Promise<Community> {
  const { data } = await api.get(`/api/communities/${id}`);
  return data;
}

export async function createCommunity(input: {
  name: string;
  description?: string;
  privacy: CommunityPrivacy;
}): Promise<Community> {
  const { data } = await api.post('/api/communities', input);
  return data;
}

// joinCommunity returns 'active' right away in a public community and
// 'pending' in a closed one (awaiting admin approval).
export async function joinCommunity(id: number): Promise<{ role: CommunityRole; status: MemberStatus }> {
  const { data } = await api.post(`/api/communities/${id}/join`);
  return data;
}

export async function leaveCommunity(id: number): Promise<void> {
  await api.delete(`/api/communities/${id}/leave`);
}

export async function fetchMembers(id: number, status?: 'pending'): Promise<CommunityMember[]> {
  const { data } = await api.get(`/api/communities/${id}/members`, {
    params: status ? { status } : undefined,
  });
  return data?.members ?? [];
}

export async function approveRequest(id: number, userId: number): Promise<void> {
  await api.post(`/api/communities/${id}/requests/${userId}/approve`);
}

export async function rejectRequest(id: number, userId: number): Promise<void> {
  await api.post(`/api/communities/${id}/requests/${userId}/reject`);
}

export async function promoteMember(id: number, userId: number): Promise<void> {
  await api.post(`/api/communities/${id}/members/${userId}/promote`);
}

export async function demoteMember(id: number, userId: number): Promise<void> {
  await api.post(`/api/communities/${id}/members/${userId}/demote`);
}

export async function kickMember(id: number, userId: number): Promise<void> {
  await api.delete(`/api/communities/${id}/members/${userId}`);
}

export async function fetchPosts(id: number): Promise<CommunityPost[]> {
  const { data } = await api.get(`/api/communities/${id}/posts`);
  return data?.posts ?? [];
}

export type NewPostInput = {
  body: string;
  photos: { uri: string; name: string; type: string }[];
  routeId?: number;
  eventId?: number;
  poll?: { question: string; options: string[] };
};

// createPost publishes an admin broadcast (multipart, like the feed's
// CreatePostScreen form).
export async function createPost(id: number, input: NewPostInput): Promise<CommunityPost> {
  const form = new FormData();
  form.append('body', input.body);
  for (const p of input.photos) {
    form.append('photos', p as unknown as Blob);
  }
  if (input.routeId) form.append('route_id', String(input.routeId));
  if (input.eventId) form.append('event_id', String(input.eventId));
  if (input.poll) {
    form.append('poll_question', input.poll.question);
    for (const o of input.poll.options) form.append('poll_options', o);
  }
  const { data } = await api.post(`/api/communities/${id}/posts`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function deletePost(postId: number): Promise<void> {
  await api.delete(`/api/communities/posts/${postId}`);
}

export async function setPostLike(postId: number, liked: boolean): Promise<{ liked: boolean; like_count: number }> {
  const { data } = liked
    ? await api.post(`/api/communities/posts/${postId}/like`)
    : await api.delete(`/api/communities/posts/${postId}/like`);
  return data;
}

// votePoll records or moves the caller's vote and returns the fresh results.
export async function votePoll(postId: number, optionId: number): Promise<Poll> {
  const { data } = await api.post(`/api/communities/posts/${postId}/vote`, { option_id: optionId });
  return data?.poll;
}

// Comment endpoints for CommentsView's `endpoints` prop: same payload shapes as
// the feed, just scoped under /api/communities.
export const communityCommentEndpoints = (postId: number) => ({
  list: `/api/communities/posts/${postId}/comments`,
  add: `/api/communities/posts/${postId}/comments`,
  commentLike: (commentId: number) => `/api/communities/comments/${commentId}/like`,
});
