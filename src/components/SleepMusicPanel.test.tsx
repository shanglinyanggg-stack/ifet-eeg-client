import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MusicPlayerController } from '../domain/music-player';
import { createSleepSessionState } from '../domain/sleep-session';
import { defaultSettings } from '../domain/settings';
import { SleepMusicPanel } from './SleepMusicPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createPlayer(): MusicPlayerController {
  const track = { id: 'one', name: '静夜引导', path: 'C:\\Music\\one.mp3' };
  return {
    selectedTrack: track,
    snapshot: {
      playing: false,
      currentTime: 24,
      duration: 180,
      volume: 0.6,
      fadeRemainingSeconds: 0,
      error: null,
      autoplayBlocked: false
    },
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(async () => undefined),
    previous: vi.fn(),
    next: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn()
  };
}

function createBlinkSnapshot(count = 0) {
  return {
    count,
    lastBlinkMs: null,
    confirmationRemainingMs: 0,
    calibrationStatus: 'complete' as const,
    calibrationProgress: 1,
    calibrationFailureReason: null,
    calibrationPeakCount: 6,
    calibrationConsensus: 0.75,
    enabledPairs: [[0, 1], [2, 3]] as Array<readonly [number, number]>,
    baselineStale: false,
    baselineHealthChecks: 3,
    adaptiveBaselineUpdates: 0,
    singleChannelRejections: 1,
    invalidGapRejections: 0,
    gapRecoveries: 1
  };
}

describe('SleepMusicPanel', () => {
  test('shows an audience-readable automatic action and working player controls', () => {
    const player = createPlayer();
    const settings = {
      ...defaultSettings.sleepMusic,
      tracks: [player.selectedTrack!],
      selectedTrackId: player.selectedTrack!.id
    };
    const session = {
      ...createSleepSessionState({
        baseVolume: settings.baseVolume,
        transitionVolume: settings.transitionVolume,
        relaxAlphaThreshold: settings.relaxAlphaThreshold,
        fadeSleepScoreThreshold: settings.fadeSleepScoreThreshold,
        stopSleepScoreThreshold: settings.stopSleepScoreThreshold,
        relaxConfirmSeconds: settings.relaxConfirmSeconds,
        transitionConfirmSeconds: settings.transitionConfirmSeconds,
        sleepConfirmSeconds: settings.sleepConfirmSeconds,
        awakeConfirmSeconds: settings.awakeConfirmSeconds,
        emaAlpha: settings.emaAlpha,
        minimumCoverage: settings.minimumCoverage
      }, 0),
      phase: 'relaxing' as const,
      previousPhase: 'relaxing' as const,
      action: 'play' as const,
      source: 'service' as const,
      coverage: 0.98,
      alphaEma: 0.42
    };
    const onVolumeChange = vi.fn();

    render(
      <SleepMusicPanel
        session={session}
        metrics={null}
        settings={settings}
        player={player}
        blink={createBlinkSnapshot()}
        onSelectTrack={vi.fn()}
        onOpenLibrary={vi.fn()}
        onRemoveTrack={vi.fn()}
        onAutoModeChange={vi.fn()}
        onVolumeChange={onVolumeChange}
        onBlinkCalibration={vi.fn()}
        onResetSession={vi.fn()}
      />
    );

    expect(screen.getByText('放松已确认')).toBeInTheDocument();
    expect(screen.getByText('自动开始播放')).toBeInTheDocument();
    expect(screen.getByText('PC 睡眠算法')).toBeInTheDocument();
    expect(screen.getAllByText('静夜引导').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('播放音乐'));
    expect(player.toggle).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('音乐音量'), { target: { value: '0.42' } });
    expect(player.setVolume).toHaveBeenCalledWith(0.42);
    expect(onVolumeChange).toHaveBeenCalledWith(0.42);
  });

  test('shows v1.2 Alpha and blink calibration telemetry', () => {
    const player = createPlayer();
    const settings = {
      ...defaultSettings.sleepMusic,
      tracks: [player.selectedTrack!],
      selectedTrackId: player.selectedTrack!.id,
      blinkControlEnabled: true
    };
    const session = {
      ...createSleepSessionState({
        baseVolume: settings.baseVolume,
        transitionVolume: settings.transitionVolume,
        relaxAlphaThreshold: settings.relaxAlphaThreshold,
        fadeSleepScoreThreshold: settings.fadeSleepScoreThreshold,
        stopSleepScoreThreshold: settings.stopSleepScoreThreshold,
        relaxConfirmSeconds: settings.relaxConfirmSeconds,
        transitionConfirmSeconds: settings.transitionConfirmSeconds,
        sleepConfirmSeconds: settings.sleepConfirmSeconds,
        awakeConfirmSeconds: settings.awakeConfirmSeconds,
        emaAlpha: settings.emaAlpha,
        minimumCoverage: settings.minimumCoverage
      }, 0),
      source: 'demo-signal' as const
    };

    render(
      <SleepMusicPanel
        session={session}
        metrics={null}
        settings={settings}
        player={player}
        blink={createBlinkSnapshot(2)}
        demoSignalStatus={{
          phase: 'ready',
          message: 'Alpha 在线 · 眨眼就绪',
          alphaCalibrationSeconds: 20,
          blinkCalibrationSeconds: 10,
          lastResponse: {
            schema_version: 'headset-demo-flags/v7',
            session_id: 'session-v120',
            timestamp_ms: 25_000,
            source_timestamp: null,
            action_flags: [],
            state_flags: ['ALPHA_PRESENT', 'BLINK_INTERACTION_ENABLED'],
            state: {
              alpha_present: true,
              calibration_complete: true,
              calibration_progress: 1,
              closed_eye_calibration_complete: false,
              closed_eye_calibration_progress: 0,
              blink_calibration_complete: true,
              blink_calibration_progress: 1,
              blink_calibration_status: 'complete',
              blink_calibration_failure_reason: null,
              blink_interaction_enabled: true,
              blink_count_pending: 2,
              blink_dual_channel_required: true,
              blink_baseline_stale: false
            },
            telemetry: {
              alpha_ratio: 0.42,
              alpha_score: 0.91,
              alpha_level: 0.86,
              alpha_step: 2,
              alpha_step_count: 3,
              alpha_volume_mode: '3',
              recommended_volume: 0.9,
              open_eye_alpha_baseline: 0.2,
              closed_eye_alpha_reference: null,
              adaptive_baseline_updates: 2,
              signal_quality: 0.98,
              selected_alpha_channels: [1, 3],
              alpha_channel_weights: [0.56, 0.44],
              alpha_channel_switches: 1,
              blink_strength_z: 4.2,
              blink_width_seconds: 0.12,
              blink_adaptive_baseline_updates: 0,
              blink_single_channel_rejections: 1,
              blink_calibration_peak_count: 6,
              blink_calibration_consensus_fraction: 0.75,
              blink_threshold_robust_z: 2.8,
              blink_rearm_robust_z: 1.2,
              blink_motion_std_threshold: 250,
              blink_enabled_channel_pairs: [[1, 2], [3, 4]],
              blink_invalid_gap_rejections: 0,
              blink_baseline_health_checks: 3,
              blink_gap_recoveries: 1
            },
            events: []
          }
        }}
        onSelectTrack={vi.fn()}
        onOpenLibrary={vi.fn()}
        onRemoveTrack={vi.fn()}
        onAutoModeChange={vi.fn()}
        onVolumeChange={vi.fn()}
        onBlinkCalibration={vi.fn()}
        onResetSession={vi.fn()}
      />
    );

    expect(screen.getByText('PC v1.2 实时算法')).toBeInTheDocument();
    expect(screen.getByText('EEG1+EEG2 / EEG3+EEG4')).toBeInTheDocument();
    expect(screen.getByText('86%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('待确认眨眼')).toBeInTheDocument();
  });
});
