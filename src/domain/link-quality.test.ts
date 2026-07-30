import { describe, expect, test } from 'vitest';
import {
  LINK_QUALITY_WINDOW_SECONDS,
  RollingLinkQualityMonitor
} from './link-quality';
import type { SampleEvent } from './protocol';

function sample(timestampMs: number, valid = true, sampleRateHz = 125): SampleEvent {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    sampleRateHz,
    valid,
    packet: {
      ppg: {
        ir1: 0,
        red1: 0,
        green1: 0,
        ir2: 0,
        red2: 0,
        green2: 0,
        accX: 0,
        accY: 0,
        accZ: 0
      }
    }
  };
}

describe('RollingLinkQualityMonitor', () => {
  test('reports effective sampling and interpolation loss over ten seconds', () => {
    const monitor = new RollingLinkQualityMonitor();
    const events = Array.from({ length: 1_250 }, (_, index) =>
      sample(index * 8, index % 4 !== 0)
    );

    const snapshot = monitor.push(events, 125);

    expect(snapshot.ready).toBe(true);
    expect(snapshot.windowSeconds).toBe(LINK_QUALITY_WINDOW_SECONDS);
    expect(snapshot.totalSamples).toBe(1_250);
    expect(snapshot.validSamples).toBe(937);
    expect(snapshot.invalidSamples).toBe(313);
    expect(snapshot.logicalSampleRateHz).toBeCloseTo(125, 5);
    expect(snapshot.effectiveSampleRateHz).toBeCloseTo(93.7, 5);
    expect(snapshot.lossRatePercent).toBeCloseTo(25.04, 5);
  });

  test('keeps only the newest ten-second window', () => {
    const monitor = new RollingLinkQualityMonitor();
    const events = Array.from({ length: 1_875 }, (_, index) =>
      sample(index * 8, index >= 625)
    );

    const snapshot = monitor.push(events, 125);

    expect(snapshot.totalSamples).toBe(1_250);
    expect(snapshot.validSamples).toBe(1_250);
    expect(snapshot.lossRatePercent).toBe(0);
  });

  test('waits for one second before presenting the rate as ready', () => {
    const monitor = new RollingLinkQualityMonitor();
    const snapshot = monitor.push(
      Array.from({ length: 63 }, (_, index) => sample(index * 8)),
      125
    );

    expect(snapshot.ready).toBe(false);
    expect(snapshot.windowSeconds).toBeCloseTo(0.504, 5);
  });

  test('resets previous-device statistics', () => {
    const monitor = new RollingLinkQualityMonitor();
    monitor.push(Array.from({ length: 125 }, (_, index) => sample(index * 8)), 125);

    expect(monitor.reset()).toEqual({
      windowSeconds: 0,
      totalSamples: 0,
      validSamples: 0,
      invalidSamples: 0,
      effectiveSampleRateHz: 0,
      logicalSampleRateHz: 0,
      lossRatePercent: 0,
      ready: false
    });
  });
});
