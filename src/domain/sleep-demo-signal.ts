export type SleepDemoActionFlag =
  | 'PLAY_MUSIC_ALPHA'
  | 'LOWER_VOLUME_ALPHA_DECAY'
  | 'BLINK_3'
  | 'BLINK_5'
  | 'VOLUME_DOWN_3_BLINKS'
  | 'VOLUME_UP_5_BLINKS';

export type SleepDemoStateFlag =
  | 'CALIBRATION_COMPLETE'
  | 'CLOSED_EYE_CALIBRATION_COMPLETE'
  | 'BLINK_CALIBRATION_COMPLETE'
  | 'BLINK_CALIBRATION_FAILED'
  | 'ALPHA_PRESENT'
  | 'BLINK_INTERACTION_ENABLED'
  | 'BLINK';

export type BlinkCalibrationStatus = 'idle' | 'running' | 'complete' | 'failed';
export type AlphaVolumeMode = '3' | '10' | '20' | 'smooth';

export interface SleepDemoSignalState {
  alpha_present: boolean;
  calibration_complete: boolean;
  calibration_progress: number;
  closed_eye_calibration_complete: boolean;
  closed_eye_calibration_progress: number;
  blink_calibration_complete: boolean;
  blink_calibration_progress: number;
  blink_calibration_status: BlinkCalibrationStatus;
  blink_calibration_failure_reason: string | null;
  blink_interaction_enabled: boolean;
  blink_count_pending: number;
  blink_dual_channel_required: boolean;
  blink_baseline_stale: boolean;
}

export interface SleepDemoSignalTelemetry {
  alpha_ratio: number | null;
  alpha_score: number | null;
  alpha_level: number | null;
  alpha_step: number;
  alpha_step_count: number;
  alpha_volume_mode: AlphaVolumeMode;
  recommended_volume: number;
  open_eye_alpha_baseline: number | null;
  closed_eye_alpha_reference: number | null;
  adaptive_baseline_updates: number;
  signal_quality: number;
  selected_alpha_channels: number[];
  alpha_channel_weights: number[];
  alpha_channel_switches: number;
  blink_strength_z: number | null;
  blink_width_seconds: number | null;
  blink_adaptive_baseline_updates: number;
  blink_single_channel_rejections: number;
  blink_calibration_peak_count: number;
  blink_calibration_consensus_fraction: number;
  blink_threshold_robust_z: number | null;
  blink_rearm_robust_z: number | null;
  blink_motion_std_threshold: number | null;
  blink_enabled_channel_pairs: number[][];
  blink_invalid_gap_rejections: number;
  blink_baseline_health_checks: number;
  blink_gap_recoveries: number;
}

export interface SleepDemoSignalEvent {
  flag: SleepDemoActionFlag | SleepDemoStateFlag | string;
  time_seconds: number;
  value: number | null;
}

export interface SleepDemoSignalResponse {
  schema_version: 'headset-demo-flags/v6' | 'headset-demo-flags/v7';
  session_id: string | null;
  timestamp_ms: number;
  source_timestamp: string | null;
  action_flags: SleepDemoActionFlag[];
  state_flags: SleepDemoStateFlag[];
  state: SleepDemoSignalState;
  telemetry: SleepDemoSignalTelemetry;
  events: SleepDemoSignalEvent[];
}

export interface SleepDemoServiceInfo {
  schema_version: 'headset-demo-flags/v6' | 'headset-demo-flags/v7';
  algorithm_version: '1.0.9' | '1.0.13';
  session_id: string | null;
  sample_rate_hz: number;
  recommended_step_milliseconds: number;
  calibration_seconds: number;
  blink_calibration_seconds: number;
  blink_quiet_baseline_seconds?: number;
  blink_calibration_requires_explicit_start: boolean;
  input_prefiltered: boolean;
  last_packet: SleepDemoSignalResponse;
}

export const DEFAULT_ALPHA_CALIBRATION_SECONDS = 20;
export const DEFAULT_BLINK_CALIBRATION_SECONDS = 10;
export const DEFAULT_BLINK_QUIET_BASELINE_SECONDS = 3;

export function calibrationProgress(
  response: SleepDemoSignalResponse | null,
  calibrationSeconds: number,
  complete: boolean,
  reportedProgress?: number
): number {
  if (complete) return 1;
  if (Number.isFinite(reportedProgress)) return clamp01(Number(reportedProgress));
  if (!response || calibrationSeconds <= 0) return 0;
  return clamp01(response.timestamp_ms / (calibrationSeconds * 1000));
}

export function formatSelectedAlphaChannels(response: SleepDemoSignalResponse | null): string {
  const channels = response?.telemetry.selected_alpha_channels ?? [];
  return channels.length > 0 ? channels.map((channel) => `EEG${channel}`).join(' + ') : '自动选择中';
}

export function blinkCalibrationFailureMessage(reason: string | null | undefined): string {
  if (reason === 'insufficient_dual_channel_peaks') {
    return '双通道有效眨眼不足 5 次，请检查 EEG1-EEG4 接触后重试';
  }
  if (reason === 'insufficient_dual_channel_consensus') {
    return '双通道同步比例不足 65%，请保持头部和下颌静止后重试';
  }
  if (reason) return '校准未通过质量门控，请重新佩戴头带后重试';
  return '';
}

// 校准配对显示：[[1,2],[3,4]] → "EEG1+EEG2 / EEG3+EEG4"
export function formatEnabledBlinkPairs(pairs: ReadonlyArray<readonly number[]> | null | undefined): string {
  if (!pairs || pairs.length === 0) return '未启用';
  return pairs
    .map((pair) => pair.map((channel) => `EEG${channel}`).join('+'))
    .join(' / ');
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
