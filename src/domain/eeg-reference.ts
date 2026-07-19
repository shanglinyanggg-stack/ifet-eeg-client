import type { TimedValue } from './dsp';

/**
 * Robust common-average reference for spectral analysis.
 *
 * The headset streams four large unsigned channel levels with substantial
 * common-mode drift. Subtracting the per-sample median keeps channel-specific
 * EEG while preventing a shared motion/electrode transient from dominating
 * Theta and Delta. The raw waveform remains untouched elsewhere in the UI.
 */
export function applyRobustMedianReference(
  selected: TimedValue[],
  channels: TimedValue[][] | undefined
): TimedValue[] {
  const usable = (channels ?? []).filter((channel) => channel.length > 0);
  if (selected.length === 0 || usable.length < 3) return selected;

  const channelMaps = usable.map((channel) => new Map(
    channel.map((point) => [point.timestamp, point.value])
  ));

  return selected.map((point) => {
    const simultaneous = channelMaps
      .map((channel) => channel.get(point.timestamp))
      .filter((value): value is number => Number.isFinite(value));
    if (simultaneous.length < 3) return point;
    return { ...point, value: point.value - median(simultaneous) };
  });
}
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
