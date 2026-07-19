import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveAudioSource,
  type MusicPlayerController,
  type MusicPlayerSnapshot
} from '../domain/music-player';
import type { SleepAutomationAction } from '../domain/sleep-session';
import type { SleepMusicTrack } from '../domain/settings';

interface UseMusicPlayerOptions {
  tracks: SleepMusicTrack[];
  selectedTrackId: string | null;
  enabled: boolean;
  autoMode: boolean;
  automationAction: SleepAutomationAction;
  targetVolume: number;
  stopFadeSeconds: number;
  onSelectTrack: (trackId: string) => void;
}

const INITIAL_SNAPSHOT: MusicPlayerSnapshot = {
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 0.6,
  fadeRemainingSeconds: 0,
  error: null,
  autoplayBlocked: false
};

export function useMusicPlayer({
  tracks,
  selectedTrackId,
  enabled,
  autoMode,
  automationAction,
  targetVolume,
  stopFadeSeconds,
  onSelectTrack
}: UseMusicPlayerOptions): MusicPlayerController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rampTimerRef = useRef<number | null>(null);
  const resumeAfterSelectionRef = useRef(false);
  const tracksRef = useRef(tracks);
  const selectedTrackIdRef = useRef(selectedTrackId);
  const onSelectTrackRef = useRef(onSelectTrack);
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);

  tracksRef.current = tracks;
  selectedTrackIdRef.current = selectedTrackId;
  onSelectTrackRef.current = onSelectTrack;

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? tracks[0] ?? null,
    [tracks, selectedTrackId]
  );

  const clearRamp = useCallback(() => {
    if (rampTimerRef.current !== null) {
      window.clearInterval(rampTimerRef.current);
      rampTimerRef.current = null;
    }
  }, []);

  const setVolume = useCallback((volume: number) => {
    clearRamp();
    const safeVolume = clamp01(volume);
    if (audioRef.current) audioRef.current.volume = safeVolume;
    setSnapshot((value) => ({ ...value, volume: safeVolume, fadeRemainingSeconds: 0 }));
  }, [clearRamp]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !selectedTrack) {
      setSnapshot((value) => ({ ...value, error: '请先选择音乐文件' }));
      return;
    }
    try {
      await audio.play();
      setSnapshot((value) => ({
        ...value,
        playing: true,
        error: null,
        autoplayBlocked: false
      }));
    } catch {
      setSnapshot((value) => ({
        ...value,
        playing: false,
        error: '自动播放被系统阻止，请点击播放按钮授权',
        autoplayBlocked: true
      }));
    }
  }, [selectedTrack]);

  const pause = useCallback(() => {
    clearRamp();
    audioRef.current?.pause();
    setSnapshot((value) => ({ ...value, playing: false, fadeRemainingSeconds: 0 }));
  }, [clearRamp]);

  const toggle = useCallback(async () => {
    if (audioRef.current?.paused ?? true) {
      await play();
    } else {
      pause();
    }
  }, [pause, play]);

  const selectRelativeTrack = useCallback((offset: number) => {
    const available = tracksRef.current;
    if (available.length === 0) return;
    const currentIndex = Math.max(0, available.findIndex((track) => track.id === selectedTrackIdRef.current));
    const nextIndex = (currentIndex + offset + available.length) % available.length;
    resumeAfterSelectionRef.current = !(audioRef.current?.paused ?? true);
    onSelectTrackRef.current(available[nextIndex].id);
  }, []);

  const previous = useCallback(() => selectRelativeTrack(-1), [selectRelativeTrack]);
  const next = useCallback(() => selectRelativeTrack(1), [selectRelativeTrack]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.currentTime = Math.max(0, Math.min(duration, seconds));
    setSnapshot((value) => ({ ...value, currentTime: audio.currentTime }));
  }, []);

  const rampVolume = useCallback((volume: number, durationMs: number, pauseAtEnd: boolean) => {
    const audio = audioRef.current;
    if (!audio) return;
    clearRamp();
    const startVolume = audio.volume;
    const endVolume = clamp01(volume);
    const safeDuration = Math.max(0, durationMs);
    if (safeDuration === 0 || Math.abs(startVolume - endVolume) < 0.005) {
      audio.volume = endVolume;
      if (pauseAtEnd) audio.pause();
      setSnapshot((value) => ({
        ...value,
        playing: pauseAtEnd ? false : value.playing,
        volume: endVolume,
        fadeRemainingSeconds: 0
      }));
      return;
    }

    const startedAt = performance.now();
    rampTimerRef.current = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const progress = Math.min(1, elapsed / safeDuration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextVolume = startVolume + (endVolume - startVolume) * eased;
      audio.volume = clamp01(nextVolume);
      setSnapshot((value) => ({
        ...value,
        volume: audio.volume,
        fadeRemainingSeconds: Math.max(0, (safeDuration - elapsed) / 1000)
      }));
      if (progress >= 1) {
        clearRamp();
        if (pauseAtEnd) audio.pause();
        setSnapshot((value) => ({
          ...value,
          playing: pauseAtEnd ? false : value.playing,
          volume: endVolume,
          fadeRemainingSeconds: 0
        }));
      }
    }, 100);
  }, [clearRamp]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = clamp01(targetVolume);
    audioRef.current = audio;

    const syncTime = () => setSnapshot((value) => ({
      ...value,
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      volume: audio.volume
    }));
    const markPlaying = () => setSnapshot((value) => ({ ...value, playing: true }));
    const markPaused = () => setSnapshot((value) => ({ ...value, playing: false }));
    const handleError = () => setSnapshot((value) => ({
      ...value,
      playing: false,
      error: '音乐文件无法读取，请重新选择'
    }));
    const handleEnded = () => {
      const available = tracksRef.current;
      if (available.length === 0) return;
      const currentIndex = Math.max(0, available.findIndex((track) => track.id === selectedTrackIdRef.current));
      const nextTrack = available[(currentIndex + 1) % available.length];
      resumeAfterSelectionRef.current = true;
      onSelectTrackRef.current(nextTrack.id);
    };

    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('loadedmetadata', syncTime);
    audio.addEventListener('volumechange', syncTime);
    audio.addEventListener('play', markPlaying);
    audio.addEventListener('pause', markPaused);
    audio.addEventListener('error', handleError);
    audio.addEventListener('ended', handleEnded);
    setSnapshot((value) => ({ ...value, volume: audio.volume }));

    return () => {
      clearRamp();
      audio.pause();
      audio.removeEventListener('timeupdate', syncTime);
      audio.removeEventListener('loadedmetadata', syncTime);
      audio.removeEventListener('volumechange', syncTime);
      audio.removeEventListener('play', markPlaying);
      audio.removeEventListener('pause', markPaused);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('ended', handleEnded);
      audioRef.current = null;
    };
  }, [clearRamp]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!selectedTrack) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setSnapshot((value) => ({ ...value, playing: false, currentTime: 0, duration: 0 }));
      return;
    }

    const shouldResume = resumeAfterSelectionRef.current;
    resumeAfterSelectionRef.current = false;
    audio.pause();
    audio.src = resolveAudioSource(selectedTrack.path);
    audio.load();
    setSnapshot((value) => ({ ...value, currentTime: 0, duration: 0, error: null }));
    if (shouldResume) void audio.play().catch(() => undefined);
  }, [selectedTrack]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!enabled) {
      pause();
      return;
    }
    if (!autoMode) {
      clearRamp();
      return;
    }

    if (automationAction === 'play') {
      clearRamp();
      audio.volume = clamp01(targetVolume);
      setSnapshot((value) => ({ ...value, volume: audio.volume, fadeRemainingSeconds: 0 }));
      void play();
    } else if (automationAction === 'fade') {
      if (!audio.paused) rampVolume(targetVolume, 650, false);
    } else if (automationAction === 'stop') {
      if (!audio.paused) rampVolume(0, Math.max(0, stopFadeSeconds) * 1000, true);
    }
  }, [
    autoMode,
    automationAction,
    clearRamp,
    enabled,
    pause,
    play,
    rampVolume,
    stopFadeSeconds,
    targetVolume
  ]);

  return {
    selectedTrack,
    snapshot,
    play,
    pause,
    toggle,
    previous,
    next,
    seek,
    setVolume
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
