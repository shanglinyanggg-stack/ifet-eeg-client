import { describe, expect, test } from 'vitest';
import { BlinkGestureDetector } from './blink-gesture';

const STEP_MS = 10;
const QUIET_MS = 3_000;
const CALIBRATION_BLINK_MS = 10_000;
const POST_CALIBRATION_GUARD_MS = 1_500;

// 高斯眨眼脉冲：σ≈0.045s，与真机眨眼宽度同量级
function pulseAt(index: number, center: number, amplitude: number): number {
  const distance = index - center;
  return amplitude * Math.exp(-0.5 * (distance / 4.5) ** 2);
}

function noise(index: number): number {
  return Math.sin(index * 12.9898) * 0.4;
}

// 生成一段样本：[eeg1..eeg4]，blinks 给出的中心位置叠加同步脉冲
function makeSample(index: number, centers: number[], channels: number, amplitude: number): [number, number, number, number] {
  const sample: [number, number, number, number] = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel += 1) {
    const active = channel < channels;
    const gain = active ? 1 - channel * 0.08 : 0;
    sample[channel] = noise(index + channel * 7)
      + centers.reduce((sum, center) => sum + pulseAt(index, center, amplitude * gain), 0);
  }
  return sample;
}

function pushRange(
  detector: BlinkGestureDetector,
  startTimestamp: number,
  durationMs: number,
  centers: number[] = [],
  channels = 4,
  amplitude = 40
): number {
  let timestamp = startTimestamp;
  for (let index = 0; index < durationMs / STEP_MS; index += 1) {
    detector.push(makeSample(index, centers, channels, amplitude), timestamp, true, 0);
    timestamp += STEP_MS;
  }
  return timestamp;
}

// 3s 安静 + 10s 每秒 0.75 次同步眨眼（多推 1 个样本跨过 13s 判定线）
function calibrate(detector: BlinkGestureDetector, channels = 4): number {
  detector.beginCalibration(0);
  let timestamp = pushRange(detector, 0, QUIET_MS, [], channels);
  const centers = Array.from({ length: 13 }, (_, index) => Math.round((0.5 + index * 0.75) * 100));
  timestamp = pushRange(detector, timestamp, CALIBRATION_BLINK_MS + STEP_MS, centers, channels);
  return timestamp;
}

// 校准结束后等待 1.5s 保护窗，再按 750ms 间隔眨眼 count 次，最后留 2.2s 尾段
function gesture(detector: BlinkGestureDetector, startTimestamp: number, count: number, channels = 4): number {
  let timestamp = pushRange(detector, startTimestamp, POST_CALIBRATION_GUARD_MS + 200, [], channels);
  for (let blinkIndex = 0; blinkIndex < count; blinkIndex += 1) {
    timestamp = pushRange(detector, timestamp, 750, [45], channels);
  }
  return timestamp;
}

describe('v1.0.13 four-channel paired blink detector', () => {
  test('completes calibration with two enabled pairs and frozen threshold', () => {
    const detector = new BlinkGestureDetector();
    const timestamp = calibrate(detector);

    const snapshot = detector.snapshot(timestamp);
    expect(snapshot.calibrationStatus).toBe('complete');
    expect(snapshot.enabledPairs).toEqual([
      [0, 1],
      [2, 3]
    ]);
    expect(snapshot.calibrationPeakCount).toBeGreaterThanOrEqual(5);
    expect(snapshot.calibrationConsensus).toBeGreaterThanOrEqual(0.65);
    expect(snapshot.baselineStale).toBe(false);
  });

  test('rejects calibration when blinks appear on a single channel only', () => {
    const detector = new BlinkGestureDetector();
    const timestamp = calibrate(detector, 1);

    const snapshot = detector.snapshot(timestamp);
    expect(snapshot.calibrationStatus).toBe('failed');
    expect(snapshot.calibrationFailureReason).toBe('insufficient_dual_channel_peaks');
  });

  test('maps three blinks to volume-down only after the five-priority gap', () => {
    const detector = new BlinkGestureDetector();
    let timestamp = calibrate(detector);
    timestamp = gesture(detector, timestamp, 3);

    expect(detector.poll(timestamp)).toBeNull();
    expect(detector.poll(timestamp + 2_100)).toBe('volume-down');
  });

  test('gives five blinks priority and never emits the pending three', () => {
    const detector = new BlinkGestureDetector();
    let timestamp = calibrate(detector);
    timestamp = gesture(detector, timestamp, 5);

    expect(detector.poll(timestamp)).toBe('volume-up');
    expect(detector.poll(timestamp + 3_000)).toBeNull();
  });

  test('rejects single-channel spikes without counting a blink', () => {
    const detector = new BlinkGestureDetector();
    let timestamp = calibrate(detector);
    timestamp = gesture(detector, timestamp, 2, 1);

    const snapshot = detector.snapshot(timestamp + 2_500);
    expect(snapshot.count).toBe(0);
    expect(detector.poll(timestamp + 2_500)).toBeNull();
  });

  test('fills invalid samples without creating a boundary blink', () => {
    const detector = new BlinkGestureDetector();
    let timestamp = calibrate(detector);
    timestamp = pushRange(detector, timestamp, POST_CALIBRATION_GUARD_MS + 200);
    for (let index = 0; index < 30; index += 1) {
      detector.push([Number.NaN, Number.NaN, Number.NaN, Number.NaN], timestamp, false, 0);
      timestamp += STEP_MS;
    }

    expect(detector.snapshot(timestamp).count).toBe(0);
    expect(detector.poll(timestamp)).toBeNull();
  });
});
