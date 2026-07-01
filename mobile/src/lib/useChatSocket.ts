// useChatSocket manages a reconnecting, token-authenticated chat WebSocket.
// It owns connect / exponential-backoff reconnect / teardown and exposes a
// stable send(); screens only supply the endpoint path and a message handler.
// Shared by the event, global and direct-message chat screens.

import { useCallback, useEffect, useRef, useState } from 'react';

import { buildWsUrl } from './chat';

type Options = {
  // API path of the WebSocket endpoint, e.g. '/api/chat/global/ws'.
  path: string;
  // When false the socket stays closed (e.g. before a conversation id resolves).
  enabled?: boolean;
  // Called with each parsed JSON frame.
  onMessage: (data: any) => void;
  // Called when a socket reopens after a drop (good for reloading history).
  onReconnect?: () => void;
};

export function useChatSocket({ path, enabled = true, onMessage, onReconnect }: Options) {
  const [connected, setConnected] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const closed = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  // Keep the latest callbacks in refs so changing them never forces a reconnect.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  const connect = useCallback(async () => {
    if (closed.current) return;
    const url = await buildWsUrl(path);
    if (!url || closed.current) return;
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      const reconnected = reconnectAttempts.current > 0;
      reconnectAttempts.current = 0;
      setConnected(true);
      if (reconnected) onReconnectRef.current?.();
    };
    socket.onclose = () => {
      setConnected(false);
      if (closed.current) return;
      reconnectAttempts.current += 1;
      if (reconnectAttempts.current > 8) return;
      const delay = Math.min(1000 * reconnectAttempts.current, 5000);
      reconnectTimer.current = setTimeout(() => connect(), delay);
    };
    socket.onmessage = (e) => {
      try {
        onMessageRef.current(JSON.parse(e.data));
      } catch {
        // ignore malformed frames
      }
    };
  }, [path]);

  useEffect(() => {
    if (!enabled) return;
    closed.current = false;
    reconnectAttempts.current = 0;
    connect();
    return () => {
      closed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const s = ws.current;
      if (s) {
        s.onopen = null;
        s.onclose = null;
        s.onmessage = null;
        s.onerror = null;
        s.close();
      }
      ws.current = null;
    };
  }, [enabled, connect]);

  // send returns false if the socket isn't open (caller can decide what to do).
  const send = useCallback((payload: unknown) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return false;
    ws.current.send(JSON.stringify(payload));
    return true;
  }, []);

  return { connected, send };
}
