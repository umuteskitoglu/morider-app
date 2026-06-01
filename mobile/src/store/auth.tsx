import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { api, setUnauthorizedHandler, TOKEN_KEY } from '../api/client';

export type User = {
  id: number;
  name: string;
  username: string;
  email: string;
  country: string;
  avatar_url?: string;
};

type AuthState = {
  user: User | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
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

  async function signOut() {
    setToken(null);
    setUser(null);
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
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
    () => ({ user, token, loading, signIn, signUp, signOut, updateUser }),
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
