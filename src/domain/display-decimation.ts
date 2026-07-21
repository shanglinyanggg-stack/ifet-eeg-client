import type { TimedValue } from './dsp';

// UI/DSP 只需要覆盖最高 45 Hz 的 Gamma，125 Hz 已满足奈奎斯特要求。
// 原始 BLE 数据仍以设备采样率进入记录文件和睡眠算法；这里只限制显示缓存。
export const DISPLAY_PROCESSING_SAMPLE_RATE_HZ = 125;

export function resolveDisplaySampleRate(inputSampleRateHz: number): number {
  if (!Number.isFinite(inputSampleRateHz) || inputSampleRateHz <= 0) {
    return DISPLAY_PROCESSING_SAMPLE_RATE_HZ;
  }
  return Math.min(DISPLAY_PROCESSING_SAMPLE_RATE_HZ, inputSampleRateHz);
}

export function decimateDisplayValues(
  previousTimestamp: number | undefined,
  values: TimedValue[],
  inputSampleRateHz: number
): TimedValue[] {
  const outputRate = resolveDisplaySampleRate(inputSampleRateHz);
  if (inputSampleRateHz <= outputRate || values.length < 2) return values;

  const minimumIntervalMs = 1_000 / outputRate;
  let lastTimestamp = previousTimestamp ?? Number.NEGATIVE_INFINITY;
  const output: TimedValue[] = [];
  for (const point of values) {
    if (point.timestamp - lastTimestamp + 1e-6 < minimumIntervalMs) continue;
    output.push(point);
    lastTimestamp = point.timestamp;
  }
  return output;
}
