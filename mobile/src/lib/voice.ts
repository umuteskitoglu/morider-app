// Always-on group ride voice chat over LiveKit. Unlike push-to-talk, once a
// rider joins their microphone stays live and they auto-subscribe to everyone
// else — a hands-free intercom for the whole group. The backend mints a
// room-join token per session (see telemetry/voice.go); the room is shared with
// the live-position WebSocket only by convention (same session code).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioSession, AndroidAudioTypePresets } from '@livekit/react-native';
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
  /** True while the local rider's own voice is being transmitted (lets the UI
   *  reassure the rider that they're actually being heard). */
  selfSpeaking: boolean;
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
  const [selfSpeaking, setSelfSpeaking] = useState(false);
  const [peers, setPeers] = useState(0);
  const roomRef = useRef<Room | null>(null);

  const updatePeers = useCallback((room: Room) => {
    setPeers(room.remoteParticipants.size);
  }, []);

  const join = useCallback(async () => {
    if (roomRef.current) return; // already connected/connecting
    setStatus('connecting');
    try {
      // Configure for hands-free comms before the session starts: route to the
      // speaker by default, prefer a connected helmet intercom (bluetooth), and
      // keep the call-style audio mode so it stays alive in the background.
      await AudioSession.configureAudio({
        android: { preferredOutputList: ['bluetooth', 'speaker'], audioTypeOptions: AndroidAudioTypePresets.communication },
        ios: { defaultOutput: 'speaker' },
      });
      await AudioSession.startAudioSession();
      const { data } = await api.post<VoiceTokenResponse>(`/api/sessions/${code}/voice-token`);

      const room = new Room();
      roomRef.current = room;

      room
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          const selfId = room.localParticipant.identity;
          setSelfSpeaking(speakers.some((s) => s.identity === selfId));
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
            setSelfSpeaking(false);
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
    } catch (err) {
      // Surface the real reason (no SFU reachable, bad token, mic denied…) — it
      // was silently swallowed before, making "bağlanamadı" impossible to debug.
      console.warn('[voice] join failed:', err);
      roomRef.current = null;
      setStatus('error');
      await AudioSession.stopAudioSession().catch(() => {});
    }
  }, [code, updatePeers]);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    setSpeaking([]);
    setSelfSpeaking(false);
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
    if (next) setSelfSpeaking(false); // muting kills the mic; reflect it at once
  }, [muted]);

  // Never leave the mic publishing past the screen's life.
  useEffect(() => {
    return () => {
      void leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, muted, speaking, selfSpeaking, peers, join, leave, toggleMute };
}
