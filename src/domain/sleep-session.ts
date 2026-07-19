import type { SleepDemoSignalResponse } from './sleep-demo-signal';

export type SleepPhase = 'ready' | 'relaxing' | 'transition' | 'light-sleep' | 'signal-poor';
export type SleepDemoPhase = 'live' | SleepPhase;
export type SleepAutomationAction = 'hold' | 'play' | 'fade' | 'stop';
export type SleepAlgorithmSource = 'local' | 'service' | 'demo-signal' | 'demo';
export type SleepServiceStage = 'W' | 'NREM' | 'REM' | null;
export type SleepInterventionAction = 'play_music' | 'stop_music' | 'hold_previous_state';

export interface SleepSessionConfig {
  baseVolume: number;
  transitionVolume: number;
  relaxAlphaThreshold: number;
  fadeSleepScoreThreshold: number;
  stopSleepScoreThreshold: number;
  relaxConfirmSeconds: number;
  transitionConfirmSeconds: number;
  sleepConfirmSeconds: number;
  awakeConfirmSeconds: number;
  emaAlpha: number;
  minimumCoverage: number;
}

export interface SleepServiceObservation {
  decisionValid: boolean;
  selectedStage: SleepServiceStage;
  selectedSleepProbability: number | null;
  interventionActionCandidate: SleepInterventionAction;
  interventionAction: SleepInterventionAction;
  autonomousMusicAllowed: boolean;
  coverage: number;
  maximumContiguousGapSeconds: number;
}

export interface SleepObservation {
  timestampMs: number;
  signalValid: boolean;
  coverage: number;
  alphaRelative: number;
  sleepScore: number;
  service?: SleepServiceObservation | null;
  demoSignal?: SleepDemoSignalResponse | null;
  demoPhase?: SleepDemoPhase;
}

export interface SleepSessionState {
  phase: SleepPhase;
  previousPhase: Exclude<SleepPhase, 'signal-poor'>;
  action: SleepAutomationAction;
  targetVolume: number;
  alphaEma: number;
  sleepScoreEma: number;
  source: SleepAlgorithmSource;
  reason: string;
  stage: SleepServiceStage;
  sleepProbability: number | null;
  coverage: number;
  candidatePhase: Exclude<SleepPhase, 'signal-poor'> | null;
  candidateSinceMs: number | null;
  enteredAtMs: number;
  updatedAtMs: number;
  completed: boolean;
}

export function createSleepSessionState(
  config: SleepSessionConfig,
  timestampMs = Date.now()
): SleepSessionState {
  return {
    phase: 'ready',
    previousPhase: 'ready',
    action: 'hold',
    targetVolume: clamp01(config.baseVolume),
    alphaEma: 0,
    sleepScoreEma: 0,
    source: 'local',
    reason: 'waiting-for-relaxation',
    stage: null,
    sleepProbability: null,
    coverage: 0,
    candidatePhase: null,
    candidateSinceMs: null,
    enteredAtMs: timestampMs,
    updatedAtMs: timestampMs,
    completed: false
  };
}

export function advanceSleepSession(
  state: SleepSessionState,
  observation: SleepObservation,
  config: SleepSessionConfig
): SleepSessionState {
  const alpha = smooth(state.alphaEma, observation.alphaRelative, config.emaAlpha);
  const sleepScore = smooth(state.sleepScoreEma, observation.sleepScore, config.emaAlpha);
  const base = {
    ...state,
    alphaEma: alpha,
    sleepScoreEma: sleepScore,
    coverage: clamp01(observation.coverage),
    updatedAtMs: observation.timestampMs
  };

  if (observation.demoPhase && observation.demoPhase !== 'live') {
    return applyDemoPhase(base, observation.demoPhase, observation.timestampMs, config);
  }

  if (observation.service && serviceSignalPoor(observation.service, config)) {
    return applyServiceObservation(base, observation.service, observation.timestampMs, config);
  }

  if (
    observation.service?.decisionValid
    && observation.service.interventionAction === 'stop_music'
  ) {
    return applyServiceObservation(base, observation.service, observation.timestampMs, config);
  }

  if (observation.demoSignal) {
    return applyDemoSignalObservation(
      base,
      observation.demoSignal,
      observation.service ?? null,
      observation.timestampMs,
      config
    );
  }

  if (observation.service) {
    return applyServiceObservation(base, observation.service, observation.timestampMs, config);
  }

  if (!observation.signalValid || observation.coverage < config.minimumCoverage) {
    const previousPhase = state.phase === 'signal-poor' ? state.previousPhase : state.phase;
    return {
      ...base,
      phase: 'signal-poor',
      previousPhase,
      action: 'hold',
      source: 'local',
      reason: 'signal-quality-low',
      candidatePhase: null,
      candidateSinceMs: null,
      enteredAtMs: state.phase === 'signal-poor' ? state.enteredAtMs : observation.timestampMs
    };
  }

  const currentPhase = state.phase === 'signal-poor' ? state.previousPhase : state.phase;
  const desiredPhase = resolveLocalPhase(currentPhase, state.completed, alpha, sleepScore, config);
  return confirmLocalPhase(base, currentPhase, desiredPhase, observation.timestampMs, config);
}

function serviceSignalPoor(
  service: SleepServiceObservation,
  config: SleepSessionConfig
): boolean {
  return service.coverage < config.minimumCoverage || service.maximumContiguousGapSeconds > 2;
}

function applyDemoSignalObservation(
  state: SleepSessionState,
  signal: SleepDemoSignalResponse,
  service: SleepServiceObservation | null,
  timestampMs: number,
  config: SleepSessionConfig
): SleepSessionState {
  const alphaRatio = signal.telemetry.alpha_ratio;
  const alphaLevel = signal.telemetry.alpha_level;
  const quality = clamp01(signal.telemetry.signal_quality);
  const recommendedVolume = clamp01(signal.telemetry.recommended_volume);
  const targetVolume = clamp01(config.baseVolume * recommendedVolume);
  const common = {
    ...state,
    alphaEma: Number.isFinite(alphaRatio) ? Number(alphaRatio) : state.alphaEma,
    sleepScoreEma: Number.isFinite(alphaLevel) ? Number(alphaLevel) * 100 : state.sleepScoreEma,
    source: 'demo-signal' as const,
    stage: service?.selectedStage ?? state.stage,
    sleepProbability: service?.selectedSleepProbability ?? state.sleepProbability,
    coverage: quality,
    candidatePhase: null,
    candidateSinceMs: null,
    updatedAtMs: timestampMs,
    completed: false
  };

  if (!signal.state.calibration_complete) {
    const phase = state.phase === 'signal-poor' ? state.previousPhase : state.phase;
    return {
      ...common,
      phase,
      previousPhase: phase,
      action: 'hold',
      reason: 'demo-alpha-calibrating'
    };
  }

  const play = signal.action_flags.includes('PLAY_MUSIC_ALPHA');
  const decay = signal.action_flags.includes('LOWER_VOLUME_ALPHA_DECAY');
  const wasDemoActive = state.source === 'demo-signal'
    && (state.phase === 'relaxing' || state.phase === 'transition');

  if (play) {
    return {
      ...common,
      phase: 'relaxing',
      previousPhase: 'relaxing',
      action: 'play',
      targetVolume,
      reason: 'demo-alpha-play',
      enteredAtMs: timestampMs
    };
  }

  if (decay || (wasDemoActive && state.phase === 'transition')) {
    return {
      ...common,
      phase: 'transition',
      previousPhase: 'transition',
      action: 'fade',
      targetVolume,
      reason: decay ? 'demo-alpha-decay' : 'demo-alpha-volume-follow',
      enteredAtMs: state.phase === 'transition' ? state.enteredAtMs : timestampMs
    };
  }

  if (wasDemoActive || signal.state.alpha_present) {
    return {
      ...common,
      phase: 'relaxing',
      previousPhase: 'relaxing',
      action: wasDemoActive ? 'fade' : 'hold',
      targetVolume,
      reason: wasDemoActive ? 'demo-alpha-volume-follow' : 'demo-alpha-present',
      enteredAtMs: state.phase === 'relaxing' ? state.enteredAtMs : timestampMs
    };
  }

  return {
    ...common,
    phase: 'ready',
    previousPhase: 'ready',
    action: 'hold',
    targetVolume: state.targetVolume,
    reason: 'demo-alpha-ready',
    enteredAtMs: state.phase === 'ready' ? state.enteredAtMs : timestampMs
  };
}

function applyDemoPhase(
  state: SleepSessionState,
  phase: SleepPhase,
  timestampMs: number,
  config: SleepSessionConfig
): SleepSessionState {
  if (phase === 'signal-poor') {
    return {
      ...state,
      phase,
      action: 'hold',
      source: 'demo',
      reason: 'demo-signal-quality-low',
      candidatePhase: null,
      candidateSinceMs: null,
      enteredAtMs: timestampMs
    };
  }

  const applied = applyPhase(state, phase, timestampMs, config, 'demo');
  if (phase === 'transition') {
    return { ...applied, targetVolume: clamp01(config.transitionVolume) };
  }
  return applied;
}

function applyServiceObservation(
  state: SleepSessionState,
  service: SleepServiceObservation,
  timestampMs: number,
  config: SleepSessionConfig
): SleepSessionState {
  const coverage = clamp01(service.coverage);
  const signalPoor = coverage < config.minimumCoverage || service.maximumContiguousGapSeconds > 2;
  if (signalPoor) {
    const previousPhase = state.phase === 'signal-poor' ? state.previousPhase : state.phase;
    return {
      ...state,
      phase: 'signal-poor',
      previousPhase,
      action: 'hold',
      source: 'service',
      reason: 'service-signal-quality-low',
      stage: service.selectedStage,
      sleepProbability: service.selectedSleepProbability,
      coverage,
      candidatePhase: null,
      candidateSinceMs: null,
      enteredAtMs: state.phase === 'signal-poor' ? state.enteredAtMs : timestampMs,
      completed: false
    };
  }

  if (!service.decisionValid) {
    const phase = state.phase === 'signal-poor' ? state.previousPhase : state.phase;
    return {
      ...state,
      phase,
      previousPhase: phase,
      action: 'hold',
      source: 'service',
      reason: 'service-warmup',
      stage: service.selectedStage,
      sleepProbability: service.selectedSleepProbability,
      coverage,
      candidatePhase: null,
      candidateSinceMs: null,
      completed: false
    };
  }

  let phase: Exclude<SleepPhase, 'signal-poor'>;
  let action: SleepAutomationAction;
  let targetVolume = state.targetVolume;
  let reason: string;

  if (service.interventionAction === 'play_music') {
    phase = 'relaxing';
    action = 'play';
    targetVolume = clamp01(config.baseVolume);
    reason = 'service-play-music';
  } else if (service.interventionAction === 'stop_music') {
    phase = 'light-sleep';
    action = 'stop';
    targetVolume = 0;
    reason = 'service-stop-music';
  } else {
    phase = service.selectedStage === 'NREM' || service.selectedStage === 'REM'
      ? 'transition'
      : 'ready';
    action = 'hold';
    reason = 'service-hold-previous-state';
  }

  return {
    ...state,
    phase,
    previousPhase: phase,
    action,
    targetVolume,
    source: 'service',
    reason,
    stage: service.selectedStage,
    sleepProbability: service.selectedSleepProbability,
    coverage,
    candidatePhase: null,
    candidateSinceMs: null,
    enteredAtMs: phase === state.phase ? state.enteredAtMs : timestampMs,
    updatedAtMs: timestampMs,
    completed: false
  };
}

function resolveLocalPhase(
  currentPhase: Exclude<SleepPhase, 'signal-poor'>,
  completed: boolean,
  alpha: number,
  sleepScore: number,
  config: SleepSessionConfig
): Exclude<SleepPhase, 'signal-poor'> {
  if (completed || currentPhase === 'light-sleep') return 'light-sleep';
  if (sleepScore >= config.stopSleepScoreThreshold) return 'light-sleep';

  const fadeRelease = Math.max(0, config.fadeSleepScoreThreshold - 5);
  if (sleepScore >= config.fadeSleepScoreThreshold) return 'transition';
  if (currentPhase === 'transition' && sleepScore >= fadeRelease) return 'transition';

  const alphaRelease = Math.max(0, config.relaxAlphaThreshold - 0.04);
  if (alpha >= config.relaxAlphaThreshold) return 'relaxing';
  if (currentPhase === 'relaxing' && alpha >= alphaRelease) return 'relaxing';
  return 'ready';
}

function confirmLocalPhase(
  state: SleepSessionState,
  currentPhase: Exclude<SleepPhase, 'signal-poor'>,
  desiredPhase: Exclude<SleepPhase, 'signal-poor'>,
  timestampMs: number,
  config: SleepSessionConfig
): SleepSessionState {
  if (desiredPhase === currentPhase) {
    return applyPhase({
      ...state,
      candidatePhase: null,
      candidateSinceMs: null
    }, currentPhase, timestampMs, config, 'local');
  }

  const confirmMs = confirmationSeconds(desiredPhase, config) * 1000;
  const candidateSinceMs = state.candidatePhase === desiredPhase && state.candidateSinceMs !== null
    ? state.candidateSinceMs
    : timestampMs;

  if (timestampMs - candidateSinceMs >= confirmMs) {
    return applyPhase({
      ...state,
      candidatePhase: null,
      candidateSinceMs: null
    }, desiredPhase, timestampMs, config, 'local');
  }

  return {
    ...applyPhase(state, currentPhase, timestampMs, config, 'local'),
    candidatePhase: desiredPhase,
    candidateSinceMs,
    reason: `confirming-${desiredPhase}`
  };
}

function applyPhase(
  state: SleepSessionState,
  phase: Exclude<SleepPhase, 'signal-poor'>,
  timestampMs: number,
  config: SleepSessionConfig,
  source: SleepAlgorithmSource
): SleepSessionState {
  let action: SleepAutomationAction = 'hold';
  let targetVolume = state.targetVolume;
  let reason = 'waiting-for-relaxation';

  if (phase === 'ready') {
    reason = 'waiting-for-relaxation';
  } else if (phase === 'relaxing') {
    action = 'play';
    targetVolume = clamp01(config.baseVolume);
    reason = 'relaxation-confirmed';
  } else if (phase === 'transition') {
    action = 'fade';
    targetVolume = transitionTarget(state.sleepScoreEma, config);
    reason = 'sleep-transition-detected';
  } else {
    action = 'stop';
    targetVolume = 0;
    reason = 'light-sleep-confirmed';
  }

  return {
    ...state,
    phase,
    previousPhase: phase,
    action,
    targetVolume,
    source,
    reason,
    stage: null,
    sleepProbability: null,
    candidatePhase: null,
    candidateSinceMs: null,
    enteredAtMs: phase === state.phase ? state.enteredAtMs : timestampMs,
    updatedAtMs: timestampMs,
    completed: state.completed || (source === 'local' && phase === 'light-sleep')
  };
}

function transitionTarget(score: number, config: SleepSessionConfig): number {
  const low = config.fadeSleepScoreThreshold;
  const high = Math.max(low + 1, config.stopSleepScoreThreshold);
  const progress = clamp01((score - low) / (high - low));
  const base = clamp01(config.baseVolume);
  const floor = Math.min(base, clamp01(config.transitionVolume));
  return base - (base - floor) * progress;
}

function confirmationSeconds(
  phase: Exclude<SleepPhase, 'signal-poor'>,
  config: SleepSessionConfig
): number {
  if (phase === 'relaxing') return Math.max(0, config.relaxConfirmSeconds);
  if (phase === 'transition') return Math.max(0, config.transitionConfirmSeconds);
  if (phase === 'light-sleep') return Math.max(0, config.sleepConfirmSeconds);
  return Math.max(0, config.awakeConfirmSeconds);
}

function smooth(previous: number, value: number, alpha: number): number {
  const factor = clamp01(alpha);
  const safeValue = Number.isFinite(value) ? value : previous;
  return previous + factor * (safeValue - previous);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
