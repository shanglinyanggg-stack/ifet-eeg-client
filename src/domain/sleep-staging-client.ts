import { invoke } from '@tauri-apps/api/core';
import type {
  AlphaVolumeMode,
  SleepDemoServiceInfo,
  SleepDemoSignalResponse
} from './sleep-demo-signal';
import type { SleepServiceObservation } from './sleep-session';
import type { SleepDemoStepRequest, SleepStagingStepRequest } from './sleep-staging-stream';

export interface SleepStagingHealth {
  service: string;
  algorithm: string | null;
  session_id: string | null;
  chunks_seen: number;
  decision_ready: boolean;
  sample_rate_hz: number;
  step_seconds: number;
  window_seconds: number;
  api_version?: number;
  package_id?: string | null;
  package_version?: string | null;
  algorithm_profile?: string | null;
  release_approved?: boolean;
  calibration_schema_version?: string | null;
  demo?: SleepDemoServiceInfo;
}

export interface SleepStagingStepResponse {
  decision_valid: boolean;
  selected_prediction3: number | null;
  selected_stage: 'W' | 'NREM' | 'REM' | null;
  selected_sleep_probability: number | null;
  sleep_detected: boolean | null;
  intervention_action_candidate: 'play_music' | 'stop_music' | 'hold_previous_state';
  intervention_action: 'play_music' | 'stop_music' | 'hold_previous_state';
  autonomous_music_allowed: boolean;
  coverage: number;
  maximum_contiguous_gap_seconds: number;
  chunks_seen?: number;
  end_seconds?: number;
  model_stage_candidate?: 'W' | 'NREM' | 'REM' | null;
  model_sleep_probability?: number | null;
  context_valid_count?: number;
  context_attempt_count?: number;
  runtime_step_ms?: number;
  phase?: number;
  quality?: number;
  recovery_low_confidence?: boolean;
  sleep_confirmation_source?: string;
}

export interface SleepAlgorithmPackageInfo {
  package_id: string;
  display_name: string;
  version: string;
  channel: string;
  algorithm_profile: string;
  release_approved: boolean;
  active: boolean;
  bundled: boolean;
  compatible: boolean;
  calibration_schema_version: string | null;
  path: string;
}

export interface SleepStagingRuntimeInfo {
  algorithm_dir: string;
  venv_ready: boolean;
  service_running: boolean;
  active_package: SleepAlgorithmPackageInfo;
  available_packages: SleepAlgorithmPackageInfo[];
  last_known_good: string | null;
}

export async function getSleepStagingHealth(endpoint: string): Promise<SleepStagingHealth> {
  return invoke<SleepStagingHealth>('sleep_staging_health', {
    endpoint: normalizeSleepEndpoint(endpoint)
  });
}

export async function resetSleepStaging(endpoint: string, sessionId: string): Promise<SleepStagingHealth> {
  return invoke<SleepStagingHealth>('sleep_staging_reset', {
    endpoint: normalizeSleepEndpoint(endpoint),
    sessionId
  });
}

export async function submitSleepStagingStep(
  endpoint: string,
  request: SleepStagingStepRequest
): Promise<SleepStagingStepResponse> {
  return invoke<SleepStagingStepResponse>('sleep_staging_step', {
    endpoint: normalizeSleepEndpoint(endpoint),
    request
  });
}

export async function resetSleepDemo(
  endpoint: string,
  sessionId: string,
  blinkInteractionEnabled: boolean
): Promise<SleepDemoSignalResponse> {
  return invoke<SleepDemoSignalResponse>('sleep_demo_reset', {
    endpoint: normalizeSleepEndpoint(endpoint),
    sessionId,
    blinkInteractionEnabled
  });
}

export async function setSleepDemoBlinkEnabled(
  endpoint: string,
  sessionId: string,
  enabled: boolean
): Promise<SleepDemoSignalResponse> {
  return invoke<SleepDemoSignalResponse>('sleep_demo_blink', {
    endpoint: normalizeSleepEndpoint(endpoint),
    sessionId,
    enabled
  });
}

export async function startSleepDemoBlinkCalibration(
  endpoint: string,
  sessionId: string,
  restart = false
): Promise<SleepDemoSignalResponse> {
  return invoke<SleepDemoSignalResponse>('sleep_demo_blink_calibration', {
    endpoint: normalizeSleepEndpoint(endpoint),
    sessionId,
    action: restart ? 'restart' : 'start'
  });
}

export async function startSleepDemoAlphaCalibration(
  endpoint: string,
  sessionId: string,
  kind: 'open-eye' | 'closed-eye',
  startedAt: string
): Promise<SleepDemoSignalResponse> {
  return invoke<SleepDemoSignalResponse>('sleep_demo_alpha_calibration', {
    endpoint: normalizeSleepEndpoint(endpoint),
    sessionId,
    kind,
    startedAt
  });
}

export async function configureSleepDemo(
  endpoint: string,
  sessionId: string,
  alphaVolumeMode: AlphaVolumeMode,
  sessionActive: boolean
): Promise<SleepDemoSignalResponse> {
  return invoke<SleepDemoSignalResponse>('sleep_demo_config', {
    endpoint: normalizeSleepEndpoint(endpoint),
    sessionId,
    alphaVolumeMode,
    sessionActive
  });
}

export async function submitSleepDemoStep(
  endpoint: string,
  request: SleepDemoStepRequest
): Promise<SleepDemoSignalResponse> {
  return invoke<SleepDemoSignalResponse>('sleep_demo_step', {
    endpoint: normalizeSleepEndpoint(endpoint),
    request
  });
}

export async function prepareSleepStagingRuntime(): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_staging_runtime_info');
}

export async function startSleepStagingService(port: number): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_staging_start', { port });
}

export async function stopSleepStagingService(): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_staging_stop');
}

export async function openSleepStagingDirectory(): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_staging_open_dir');
}

export async function importSleepAlgorithmPackage(source: string): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_algorithm_import', { source });
}

export async function activateSleepAlgorithmPackage(
  packageId: string,
  version: string
): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_algorithm_activate', { packageId, version });
}

export async function rollbackSleepAlgorithmPackage(): Promise<SleepStagingRuntimeInfo> {
  return invoke<SleepStagingRuntimeInfo>('sleep_algorithm_rollback');
}

export async function pickSleepAlgorithmPackage(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'iFET Algorithm', extensions: ['ifet-algorithm', 'zip'] }]
  });
  return typeof selected === 'string' ? selected : null;
}

export function toServiceObservation(response: SleepStagingStepResponse): SleepServiceObservation {
  return {
    decisionValid: response.decision_valid,
    selectedStage: response.selected_stage,
    selectedSleepProbability: response.selected_sleep_probability,
    interventionActionCandidate: response.intervention_action_candidate,
    interventionAction: response.intervention_action,
    autonomousMusicAllowed: response.autonomous_music_allowed,
    coverage: response.coverage,
    maximumContiguousGapSeconds: response.maximum_contiguous_gap_seconds
  };
}

export function normalizeSleepEndpoint(endpoint: string): string {
  const value = endpoint.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Sleep staging endpoint must be a valid local URL');
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname)) {
    throw new Error('Sleep staging endpoint must use local HTTP');
  }
  return url.toString().replace(/\/$/, '');
}
