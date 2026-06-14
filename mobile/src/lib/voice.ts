// Always-on group ride voice chat over LiveKit. Unlike push-to-talk, once a
// rider joins their microphone stays live and they auto-subscribe to everyone
// else — a hands-free intercom for the whole group. The backend mints a
// room-join token per session (see telemetry/voice.go); the room is shared with
// the live-position WebSocket only by convention (same session code).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioSession } from '@livekit/react-native';
import {
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';

import { api } from '../api/client';

export type VoiceStatus = 'off' | 'connecting' | 'connected' | 'error';

type VoiceTokenResponse = { url: string; token: string; room: string };

// Identity minted by the backend is "user-<id>"; recover the numeric id so the
// UI can line speakers up with the map markers.
export function userIdFromIdentity(identity: string): number | null {
  const m = /^user-(\d+)$/.exec(identity);
  return m ? Number(m[1]) : null;
}

export type GroupVoice = {
  status: VoiceStatus;
  muted: boolean;
  /** Numeric user ids currently transmitting (active speakers). */
  speaking: number[];
  /** Count of remote riders connected to the voice room (excludes self). */
  peers: number;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => Promise<void>;
};

// useGroupVoice manages the LiveKit room lifecycle for one session. Connecting is
// explicit (the rider taps "join voice"); leaving happens on tap or when the
// screen unmounts so the mic never stays hot after the rider is gone.
export function useGroupVoice(code: string): GroupVoice {
  const [status, setStatus] = useState<VoiceStatus>('off');
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState<number[]>([]);
  const [peers, setPeers] = useState(0);
  const roomRef = useRef<Room | null>(null);

  const updatePeers = useCallback((room: Room) => {
    setPeers(room.remoteParticipants.size);
  }, []);

  const join = useCallback(async () => {
    if (roomRef.current) return; // already connected/connecting
    setStatus('connecting');
    try {
      await AudioSession.startAudioSession();
      const { data } = await api.post<VoiceTokenResponse>(`/api/sessions/${code}/voice-token`);

      const room = new Room();
      roomRef.current = room;

      room
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          setSpeaking(
            speakers
              .map((s) => userIdFromIdentity(s.identity))
              .filter((id): id is number => id != null),
          );
        })
        .on(RoomEvent.ParticipantConnected, () => updatePeers(room))
        .on(RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => updatePeers(room))
        .on(RoomEvent.Disconnected, () => {
          // Server- or network-initiated drop: reflect it and release audio.
          if (roomRef.current === room) {
            roomRef.current = null;
            setStatus('off');
            setSpeaking([]);
            setPeers(0);
            void AudioSession.stopAudioSession();
          }
        });

      await room.connect(data.url, data.token);
      // Always-on: publish the mic immediately, no push-to-talk gate.
      await room.localParticipant.setMicrophoneEnabled(true);
      updatePeers(room);
      setMuted(false);
      setStatus('connected');
    } catch {
      roomRef.current = null;
      setStatus('error');
      await AudioSession.stopAudioSession().catch(() => {});
    }
  }, [code, updatePeers]);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    setSpeaking([]);
    setPeers(0);
    setStatus('off');
    if (room) await room.disconnect().catch(() => {});
    await AudioSession.stopAudioSession().catch(() => {});
  }, []);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }, [muted]);

  // Never leave the mic publishing past the screen's life.
  useEffect(() => {
    return () => {
      void leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, muted, speaking, peers, join, leave, toggleMute };
}
