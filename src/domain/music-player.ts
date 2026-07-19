import { convertFileSrc } from '@tauri-apps/api/core';
import type { SleepMusicTrack } from './settings';

export interface MusicPlayerSnapshot {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  fadeRemainingSeconds: number;
  error: string | null;
  autoplayBlocked: boolean;
}

export interface MusicPlayerController {
  selectedTrack: SleepMusicTrack | null;
  snapshot: MusicPlayerSnapshot;
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => Promise<void>;
  previous: () => void;
  next: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
}

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function resolveAudioSource(path: string): string {
  if (/^(blob:|data:|https?:|asset:|\/)/i.test(path)) return path;
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return convertFileSrc(path);
  }
  return path.replace(/\\/g, '/');
}
