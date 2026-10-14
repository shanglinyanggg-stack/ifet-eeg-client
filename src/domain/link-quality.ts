import type { SampleEvent } from './protocol';

export const LINK_QUALITY_WINDOW_SECONDS = 10;
const LINK_QUALITY_WINDOW_MS = LINK_QUALITY_WINDOW_SECONDS * 1_000;
const MIN_READY_SECONDS = 1;

interface WindowSample {
  timestampMs: number;
  valid: boolean;
}

export interface LinkQualitySnapshot {
  windowSeconds: number;
  totalSamples: number;
  validSamples: number;
  invalidSamples: number;
  effectiveSampleRateHz: number;
  logicalSampleRateHz: number;
  lossRatePercent: number;
  ready: boolean;
}

export function createEmptyLinkQuality(): LinkQualitySnapshot {
  return {
    windowSeconds: 0,
    totalSamples: 0,
    validSamples: 0,
    invalidSamples: 0,
    effectiveSampleRateHz: 0,
    logicalSampleRateHz: 0,
    lossRatePercent: 0,
    ready: false
  };
}

/**
 * Tracks real received rows, with old replay placeholders explicitly excluded.
 * Missing target-rate slots are a coverage deficit, not proof of RF packet loss.
 */
export class RollingLinkQualityMonitor {
  private samples: WindowSample[] = [];
  private latestTimestampMs = Number.NEGATIVE_INFINITY;

  reset(): LinkQualitySnapshot {
    this.samples = [];
    this.latestTimestampMs = Number.NEGATIVE_INFINITY;
    return createEmptyLinkQuality();
  }

  push(events: readonly SampleEvent[], expectedSampleRateHz: number): LinkQualitySnapshot {
    const sampleIntervalMs = 1_000 / Math.max(1, expectedSampleRateHz);
    for (const event of events) {
      const parsedTimestamp = Date.parse(event.timestamp);
      const timestampMs = Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : Number.isFinite(this.latestTimestampMs)
          ? this.latestTimestampMs + sampleIntervalMs
          : Date.now();

      // A device-clock re-anchor can move slightly backwards. Keep the metric
      // clock monotonic without changing the timestamps saved in the CSV.
      const monotonicTimestampMs = Number.isFinite(this.latestTimestampMs)
        ? Math.max(timestampMs, this.latestTimestampMs + sampleIntervalMs)
        : timestampMs;
      this.latestTimestampMs = monotonicTimestampMs;
      this.samples.push({
        timestampMs: monotonicTimestampMs,
        valid: event.valid !== false && event.observed !== false
      });
    }

    if (this.samples.length === 0) return createEmptyLinkQuality();

    const cutoffMs = this.latestTimestampMs - LINK_QUALITY_WINDOW_MS + sampleIntervalMs;
    let firstRetained = 0;
    while (
      firstRetained < this.samples.length
      && this.samples[firstRetained].timestampMs < cutoffMs
    ) {
      firstRetained += 1;
    }
    if (firstRetained > 0) this.samples = this.samples.slice(firstRetained);

    const totalSamples = this.samples.length;
    const validSamples = this.samples.reduce(
      (count, sample) => count + (sample.valid ? 1 : 0),
      0
    );
    const invalidSamples = totalSamples - validSamples;
    const observedDurationMs = Math.min(
      LINK_QUALITY_WINDOW_MS,
      Math.max(
        sampleIntervalMs,
        this.latestTimestampMs - this.samples[0].timestampMs + sampleIntervalMs
      )
    );
    const windowSeconds = observedDurationMs / 1_000;

    return {
      windowSeconds,
      totalSamples,
      validSamples,
      invalidSamples,
      effectiveSampleRateHz: validSamples / windowSeconds,
      logicalSampleRateHz: totalSamples / windowSeconds,
      lossRatePercent: Math.max(0,Math.min(100,(1-validSamples/Math.max(totalSamples,windowSeconds*expectedSampleRateHz))*100)),
      ready: windowSeconds >= MIN_READY_SECONDS
    };
  }
}
