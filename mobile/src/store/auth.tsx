import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { api, setUnauthorizedHandler, TOKEN_KEY } from '../api/client';
import { getGoogleIdToken, googleSignOut } from '../api/googleAuth';
import { unregisterPushToken } from '../lib/push';

export type User = {
  id: number;
  name: string;
  username: string;
  email: string;
  country: string;
  avatar_url?: string;
  bio?: string;
  license_type?: string;
  bike_type?: string;
  show_garage?: boolean;
  show_rides?: boolean;
  share_live_location?: boolean;
};

type AuthState = {
  user: User | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  updateUser: (partial: Partial<User>) => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

const USER_KEY = 'morider.user';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [storedToken, storedUser] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(USER_KEY),
      ]);
      if (storedToken) setToken(storedToken);
      if (storedUser) setUser(JSON.parse(storedUser));
      setLoading(false);
    })();
  }, []);

  async function persist(nextToken: string, nextUser: User) {
    setToken(nextToken);
    setUser(nextUser);
    await AsyncStorage.multiSet([
      [TOKEN_KEY, nextToken],
      [USER_KEY, JSON.stringify(nextUser)],
    ]);
  }

  async function signIn(email: string, password: string) {
    const { data } = await api.post('/api/auth/login', { email, password });
    await persist(data.token, data.user);
  }

  async function signUp(name: string, email: string, password: string) {
    const { data } = await api.post('/api/auth/signup', { name, email, password });
    await persist(data.token, data.user);
  }

  // One endpoint covers both cases: the app cannot know whether this Google
  // account is new to Morider, and the backend links it to an existing account
  // when the verified email matches.
  async function signInWithGoogle() {
    const idToken = await getGoogleIdToken();
    const { data } = await api.post('/api/auth/google', { id_token: idToken });
    await persist(data.token, data.user);
  }

  async function signOut() {
    // Drop this device from the account first, while the auth token is still
    // valid. Otherwise the push_tokens row keeps pointing at this rider and the
    // next person to use the phone receives their notifications.
    await unregisterPushToken();
    setToken(null);
    setUser(null);
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
    // Also drop the native Google session, so signing out and back in offers
    // the account picker instead of silently reusing the last account.
    await googleSignOut();
  }

  // Any 401 from the API (expired/invalid token) clears the session so the app
  // falls back to the login screen instead of showing a stale-token error.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
      AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]).catch(() => {});
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  async function updateUser(partial: Partial<User>) {
    if (!user) return;
    const next = { ...user, ...partial };
    setUser(next);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(next));
  }

  const value = useMemo<AuthState>(
    () => ({ user, token, loading, signIn, signUp, signInWithGoogle, signOut, updateUser }),
    [user, token, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
