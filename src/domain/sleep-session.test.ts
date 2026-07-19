import { describe, expect, test } from 'vitest';
import type { SleepDemoSignalResponse } from './sleep-demo-signal';
import {
  advanceSleepSession,
  createSleepSessionState,
  type SleepSessionConfig
} from './sleep-session';

const config: SleepSessionConfig = {
  baseVolume: 0.6,
  transitionVolume: 0.18,
  relaxAlphaThreshold: 0.32,
  fadeSleepScoreThreshold: 45,
  stopSleepScoreThreshold: 68,
  relaxConfirmSeconds: 2,
  transitionConfirmSeconds: 1,
  sleepConfirmSeconds: 1,
  awakeConfirmSeconds: 3,
  emaAlpha: 1,
  minimumCoverage: 0.6
};

function demoSignal(
  actionFlags: SleepDemoSignalResponse['action_flags'] = [],
  patch: Partial<SleepDemoSignalResponse['state']> = {},
  recommendedVolume = 1
): SleepDemoSignalResponse {
  return {
    schema_version: 'headset-demo-flags/v6',
    session_id: 'demo-session',
    timestamp_ms: 21_000,
    source_timestamp: null,
    action_flags: actionFlags,
    state_flags: [],
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
      blink_count_pending: 0,
      blink_dual_channel_required: true,
      ...patch
    },
    telemetry: {
      alpha_ratio: 0.42,
      alpha_score: 0.91,
      alpha_level: 0.86,
      alpha_step: 2,
      alpha_step_count: 3,
      alpha_volume_mode: '3',
      recommended_volume: recommendedVolume,
      open_eye_alpha_baseline: 0.2,
      closed_eye_alpha_reference: null,
      adaptive_baseline_updates: 0,
      signal_quality: 0.98,
      selected_alpha_channels: [1, 2],
      alpha_channel_weights: [0.56, 0.44],
      alpha_channel_switches: 1,
      blink_strength_z: null,
      blink_width_seconds: null,
      blink_adaptive_baseline_updates: 0,
      blink_single_channel_rejections: 0,
      blink_calibration_peak_count: 6,
      blink_calibration_consensus_fraction: 0.75,
      blink_threshold_robust_z: 2.8,
      blink_rearm_robust_z: 1.2,
      blink_motion_std_threshold: 250
    },
    events: []
  };
}

describe('sleep session automation', () => {
  test('confirms relaxation before starting music', () => {
    let state = createSleepSessionState(config, 0);

    state = advanceSleepSession(state, {
      timestampMs: 1_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.4,
      sleepScore: 20
    }, config);
    expect(state.phase).toBe('ready');
    expect(state.candidatePhase).toBe('relaxing');

    state = advanceSleepSession(state, {
      timestampMs: 2_999,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.4,
      sleepScore: 20
    }, config);
    expect(state.phase).toBe('ready');

    state = advanceSleepSession(state, {
      timestampMs: 3_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.4,
      sleepScore: 20
    }, config);
    expect(state.phase).toBe('relaxing');
    expect(state.action).toBe('play');
    expect(state.targetVolume).toBe(0.6);
  });

  test('reduces volume progressively during the transition stage', () => {
    const immediate = {
      ...config,
      relaxConfirmSeconds: 0,
      transitionConfirmSeconds: 0
    };
    let state = createSleepSessionState(immediate, 0);

    state = advanceSleepSession(state, {
      timestampMs: 1_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.2,
      sleepScore: 56
    }, immediate);

    expect(state.phase).toBe('transition');
    expect(state.action).toBe('fade');
    expect(state.targetVolume).toBeLessThan(immediate.baseVolume);
    expect(state.targetVolume).toBeGreaterThan(immediate.transitionVolume);
  });

  test('stops after sleep confirmation and latches the local session', () => {
    const immediate = { ...config, sleepConfirmSeconds: 0, awakeConfirmSeconds: 0 };
    let state = createSleepSessionState(immediate, 0);

    state = advanceSleepSession(state, {
      timestampMs: 1_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.1,
      sleepScore: 82
    }, immediate);
    expect(state.phase).toBe('light-sleep');
    expect(state.action).toBe('stop');
    expect(state.targetVolume).toBe(0);

    state = advanceSleepSession(state, {
      timestampMs: 5_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.5,
      sleepScore: 10
    }, immediate);
    expect(state.phase).toBe('light-sleep');
    expect(state.action).toBe('stop');
  });

  test('holds the previous player target when signal quality is poor', () => {
    const previous = {
      ...createSleepSessionState(config, 0),
      phase: 'relaxing' as const,
      action: 'play' as const,
      targetVolume: 0.6
    };

    const state = advanceSleepSession(previous, {
      timestampMs: 1_000,
      signalValid: false,
      coverage: 0.42,
      alphaRelative: 0.4,
      sleepScore: 20
    }, config);

    expect(state.phase).toBe('signal-poor');
    expect(state.action).toBe('hold');
    expect(state.targetVolume).toBe(0.6);
    expect(state.previousPhase).toBe('relaxing');
  });

  test('uses only the service intervention action, never its candidate', () => {
    const state = advanceSleepSession(createSleepSessionState(config, 0), {
      timestampMs: 30_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0.2,
      sleepScore: 80,
      service: {
        decisionValid: true,
        selectedStage: 'NREM',
        selectedSleepProbability: 0.91,
        interventionActionCandidate: 'stop_music',
        interventionAction: 'hold_previous_state',
        autonomousMusicAllowed: false,
        coverage: 1,
        maximumContiguousGapSeconds: 0
      }
    }, config);

    expect(state.source).toBe('service');
    expect(state.action).toBe('hold');
    expect(state.phase).toBe('transition');
  });

  test('supports deterministic audience demo stages', () => {
    const state = advanceSleepSession(createSleepSessionState(config, 0), {
      timestampMs: 10_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0,
      sleepScore: 0,
      demoPhase: 'transition'
    }, config);

    expect(state.source).toBe('demo');
    expect(state.phase).toBe('transition');
    expect(state.action).toBe('fade');
    expect(state.targetVolume).toBe(config.transitionVolume);
  });

  test('uses the v1.2 Alpha flag to start and then smoothly follow recommended volume', () => {
    let state = advanceSleepSession(createSleepSessionState(config, 0), {
      timestampMs: 21_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0,
      sleepScore: 0,
      demoSignal: demoSignal(['PLAY_MUSIC_ALPHA'])
    }, config);

    expect(state.source).toBe('demo-signal');
    expect(state.phase).toBe('relaxing');
    expect(state.action).toBe('play');
    expect(state.targetVolume).toBe(0.6);

    state = advanceSleepSession(state, {
      timestampMs: 21_500,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0,
      sleepScore: 0,
      demoSignal: demoSignal([], {}, 0.5)
    }, config);

    expect(state.phase).toBe('relaxing');
    expect(state.action).toBe('fade');
    expect(state.targetVolume).toBe(0.3);
  });

  test('treats Alpha decay as volume fade rather than formal sleep', () => {
    const state = advanceSleepSession(createSleepSessionState(config, 0), {
      timestampMs: 24_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0,
      sleepScore: 0,
      demoSignal: demoSignal(['LOWER_VOLUME_ALPHA_DECAY'], { alpha_present: false }, 0.4)
    }, config);

    expect(state.phase).toBe('transition');
    expect(state.action).toBe('fade');
    expect(state.reason).toBe('demo-alpha-decay');
    expect(state.targetVolume).toBeCloseTo(0.24);
  });

  test('gives formal sleep stop priority over Demo flags', () => {
    const state = advanceSleepSession(createSleepSessionState(config, 0), {
      timestampMs: 30_000,
      signalValid: true,
      coverage: 1,
      alphaRelative: 0,
      sleepScore: 0,
      demoSignal: demoSignal(['PLAY_MUSIC_ALPHA']),
      service: {
        decisionValid: true,
        selectedStage: 'NREM',
        selectedSleepProbability: 0.9,
        interventionActionCandidate: 'stop_music',
        interventionAction: 'stop_music',
        autonomousMusicAllowed: true,
        coverage: 1,
        maximumContiguousGapSeconds: 0
      }
    }, config);

    expect(state.source).toBe('service');
    expect(state.phase).toBe('light-sleep');
    expect(state.action).toBe('stop');
  });
});
