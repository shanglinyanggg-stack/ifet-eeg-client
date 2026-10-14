import type { TimedValue } from './dsp';

// Native-rate signal buffers. Only the final canvas uses pixel min/max
// envelopes; signal/DSP samples must not be silently thinned to 125 Hz.
export const DISPLAY_PROCESSING_SAMPLE_RATE_HZ = 125;

export function resolveDisplaySampleRate(inputSampleRateHz: number): number {
  if (!Number.isFinite(inputSampleRateHz) || inputSampleRateHz <= 0) {
    return DISPLAY_PROCESSING_SAMPLE_RATE_HZ;
  }
  return inputSampleRateHz;
}

export function decimateDisplayValues(
  previousTimestamp: number | undefined,
  values: TimedValue[],
  inputSampleRateHz: number
): TimedValue[] {
  void previousTimestamp; void inputSampleRateHz;
  return values;
}
