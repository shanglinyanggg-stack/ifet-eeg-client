import { EEG_SAMPLE_RATE, FilterChain, type TimedValue } from './dsp';

export type DebugEegFilterMode = 'raw' | '0.5-30' | '8-13' | '0.7-15';
export type DebugSignalView = 'eeg' | 'ppg';
export type DebugEegScale = 'auto' | '2000' | '5000' | '10000' | '20000';

export const debugEegFilterOptions: Array<{ value: DebugEegFilterMode; label: string }> = [
  { value: 'raw', label: '显示原始' },
  { value: '0.5-30', label: '显示 0.5–30 Hz' },
  { value: '8-13', label: '显示 Alpha 8–13 Hz' },
  { value: '0.7-15', label: '显示 0.7–15 Hz（眨眼）' }
];

export const debugEegScaleOptions: Array<{ value: DebugEegScale; label: string }> = [
  { value: '2000', label: 'EEG ±2k' },
  { value: '5000', label: 'EEG ±5k' },
  { value: '10000', label: 'EEG ±10k' },
  { value: '20000', label: 'EEG ±20k' },
  { value: 'auto', label: 'EEG 自动' }
];

/** Matches EEGSleepUpper's 10-second, median-centered debug display filters. */
export function filterDebugEegWindow(
  values: TimedValue[],
  mode: DebugEegFilterMode,
  sampleRate = EEG_SAMPLE_RATE
): TimedValue[] {
  const window = values.slice(-sampleRate * 10);
  if (window.length === 0) return [];
  const center = median(window.map((point) => point.value));
  const centered = window.map((point) => ({ ...point, value: point.value - center }));
  if (mode === 'raw' || centered.length < 32) return centered;

  const [low, high, order] = mode === '0.5-30'
    ? [0.5, 30, 4] as const
    : mode === '8-13'
      ? [8, 13, 4] as const
      : [0.7, 15, 2] as const;
  const chain = FilterChain.butterworthBandpass({ low, high, sampleRate, order });
  return centered.map((point) => ({ ...point, value: chain.process(point.value) }));
}

/**
 * TD10 optical channels are unsigned 24-bit measurements with a large LED/DC
 * baseline. Display the pulsatile AC component without modifying acquisition
 * buffers or recorded CSV values.
 */
export function filterPpgDisplayWindow(
  values: TimedValue[],
  sampleRate = EEG_SAMPLE_RATE,
  windowSeconds?: number
): TimedValue[] {
  const window = windowSeconds
    ? values.slice(-Math.max(1, Math.round(sampleRate * windowSeconds)))
    : values;
  if (window.length === 0) return [];
  const center = median(window.map((point) => point.value));
  const centered = window.map((point) => ({ ...point, value: point.value - center }));
  if (centered.length < 32) return centered;
  const chain = FilterChain.butterworthBandpass({
    low: 0.35,
    high: 8,
    sampleRate,
    order: 2
  });
  return centered.map((point) => ({ ...point, value: chain.process(point.value) }));
}

export function resolveDebugScale(scale: DebugEegScale): number | undefined {
  return scale === 'auto' ? undefined : Number(scale);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
