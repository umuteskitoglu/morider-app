import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TOKEN_KEY = 'morider.token';

const baseURL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';

export const api = axios.create({
  baseURL,
  timeout: 15000,
});

// Attach the bearer token to every request when available.
api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// When any request comes back 401 (expired/invalid token), notify the app so it
// can clear the session and send the user back to login instead of surfacing a
// confusing "invalid or expired token" alert on whichever screen made the call.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      onUnauthorized?.();
    }
    return Promise.reject(err);
  },
);

export function apiBaseURL(): string {
  return baseURL;
}

// Widths the media endpoint will resize to. Anything else is served at its
// original resolution, so keep these in sync with derivativeWidths in
// backend/internal/feed/media.go.
export const MEDIA_THUMB = 320;
export const MEDIA_FULL = 1440;

/**
 * Absolute URL for a stored media path, optionally asking the server for a
 * width-capped copy. Older posts hold multi-megapixel originals; decoding those
 * to fill a 120px grid cell is what makes the feed and profile stutter.
 */
export function mediaURL(path: string, width?: number): string {
  const url = baseURL + path;
  return width ? `${url}?w=${width}` : url;
}

export type ApiError = {
  error: string;
};

export function errorMessage(err: unknown, fallback = 'Bir hata oluştu'): string {
  if (axios.isAxiosError(err)) {
    // No response means the request never reached the server: timeout, no
    // internet, or DNS/connection failure. Axios's own message for these
    // ("timeout of 15000ms exceeded", "Network Error") isn't something a
    // user should ever see, so show a friendly connectivity message instead.
    if (!err.response) {
      return 'İnternet bağlantınızı kontrol edip tekrar deneyin.';
    }
    return (err.response.data as ApiError)?.error ?? err.message ?? fallback;
  }
  return fallback;
}
