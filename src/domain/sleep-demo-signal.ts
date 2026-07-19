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
  blink_baseline_frozen?: boolean;
  blink_control_ready?: boolean;
  blink_stabilization_remaining_seconds?: number;
  blink_group_decoder_enabled?: boolean;
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
  open_eye_alpha_initial_baseline?: number | null;
  alpha_on_threshold?: number | null;
  alpha_off_threshold?: number | null;
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
  blink_baseline_recovery_progress?: number;
  blink_baseline_recoveries?: number;
  blink_runtime_disabled_pairs?: number[][];
  blink_burst_rejections?: number;
  blink_template_ready?: boolean;
  blink_template_correlation?: number | null;
  blink_template_matches?: number;
  blink_template_rejections?: number;
  blink_group_evaluations?: number;
  blink_group_commands?: number;
  blink_group_rejections?: number;
}

export interface SleepDemoSignalEvent {
  flag: SleepDemoActionFlag | SleepDemoStateFlag | string;
  time_seconds: number;
  value: number | null;
}

export interface SleepDemoSignalResponse {
  schema_version: 'headset-demo-flags/v6' | 'headset-demo-flags/v7' | 'headset-demo-flags/v9';
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
  schema_version: 'headset-demo-flags/v6' | 'headset-demo-flags/v7' | 'headset-demo-flags/v9';
  algorithm_version: '1.0.9' | '1.0.13' | '1.0.21';
  session_id: string | null;
  sample_rate_hz: number;
  recommended_step_milliseconds: number;
  calibration_seconds: number;
  closed_eye_calibration_seconds?: number;
  blink_calibration_seconds: number;
  blink_quiet_baseline_seconds?: number;
  blink_calibration_requires_explicit_start: boolean;
  input_prefiltered: boolean;
  last_packet: SleepDemoSignalResponse;
}

export const DEFAULT_ALPHA_CALIBRATION_SECONDS = 20;
export const DEFAULT_CLOSED_EYE_CALIBRATION_SECONDS = 20;
export const DEFAULT_BLINK_CALIBRATION_SECONDS = 10;
export const DEFAULT_BLINK_QUIET_BASELINE_SECONDS = 3;

const ACTION_LABELS: Record<SleepDemoActionFlag, string> = {
  PLAY_MUSIC_ALPHA: 'Alpha 达到阈值：开始播放音乐',
  LOWER_VOLUME_ALPHA_DECAY: 'Alpha 持续下降：降低音乐音量',
  BLINK_3: '识别到 3 次眨眼',
  BLINK_5: '识别到 5 次眨眼',
  VOLUME_DOWN_3_BLINKS: '3 次眨眼：降低音量',
  VOLUME_UP_5_BLINKS: '5 次眨眼：提高音量'
};

const STATE_LABELS: Partial<Record<SleepDemoStateFlag, string>> = {
  CALIBRATION_COMPLETE: '睁眼基线就绪',
  CLOSED_EYE_CALIBRATION_COMPLETE: '闭眼基线就绪',
  BLINK_CALIBRATION_COMPLETE: '眨眼基线就绪',
  BLINK_CALIBRATION_FAILED: '眨眼基线失败',
  ALPHA_PRESENT: '检测到 Alpha',
  BLINK_INTERACTION_ENABLED: '眨眼控制已开启',
  BLINK: '检测到单次眨眼'
};

export function summarizeAlgorithmAction(flags: readonly SleepDemoActionFlag[]): string | null {
  const preferred: SleepDemoActionFlag[] = [
    'VOLUME_UP_5_BLINKS',
    'VOLUME_DOWN_3_BLINKS',
    'PLAY_MUSIC_ALPHA',
    'LOWER_VOLUME_ALPHA_DECAY',
    'BLINK_5',
    'BLINK_3'
  ];
  const selected = preferred.find((flag) => flags.includes(flag));
  return selected ? ACTION_LABELS[selected] : null;
}

export function translateAlgorithmState(flag: SleepDemoStateFlag | string): string {
  return STATE_LABELS[flag as SleepDemoStateFlag] ?? flag;
}

export function formatReferenceStrength(value: number | null | undefined, suffix = ''): string | null {
  if (!Number.isFinite(value)) return null;
  const numeric = Number(value);
  const magnitude = Math.abs(numeric);
  const text = magnitude >= 1_000 || (magnitude > 0 && magnitude < 0.001)
    ? numeric.toExponential(2)
    : numeric.toFixed(magnitude >= 100 ? 1 : magnitude >= 10 ? 2 : 3);
  return `${text}${suffix}`;
}

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
