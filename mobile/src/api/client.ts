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

export function apiBaseURL(): string {
  return baseURL;
}

export type ApiError = {
  error: string;
};

export function errorMessage(err: unknown, fallback = 'Bir hata oluştu'): string {
  if (axios.isAxiosError(err)) {
    return (err.response?.data as ApiError)?.error ?? err.message ?? fallback;
  }
  return fallback;
}
