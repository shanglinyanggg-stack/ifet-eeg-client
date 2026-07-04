import { Biquad, computeShare, createEegBands, resolveScale, type BandShare, type TimedValue } from '../domain/dsp';
import type { EegChannel, EegSettings } from '../domain/settings';
import { WaveformCanvas, type WaveformSeries } from './WaveformCanvas';
import { BandShareChart } from './BandShareChart';

interface EegModeViewProps {
  channel: EegChannel;
  values: TimedValue[];
  settings: EegSettings;
}

export function EegModeView({ channel, values, settings }: EegModeViewProps) {
  const bands = deriveBandSeries(values, settings);
  const rawScale = resolveScale(settings.scale, values.map((item) => item.value));
  const shareValues = computeShare(
    bands.map((band) => ({
      label: band.label as BandShare['label'],
      value: averageAbs(band.values)
    }))
  );
  const bandColors = Object.fromEntries(bands.map((band) => [band.label, band.color]));
  const combined: WaveformSeries[] = [
    { label: channel.toUpperCase(), color: 'var(--wave-raw)', values, scale: rawScale },
    ...bands
  ];

  return (
    <div className="eeg-layout">
      <WaveformCanvas title={`${channel.toUpperCase()} 原始波形`} series={[{ label: channel.toUpperCase(), color: '#38bdf8', values, scale: rawScale }]} height={210} />
      <BandShareChart shares={shareValues} colors={bandColors} />
      <WaveformCanvas title="频带分离" series={bands} height={380} />
      <WaveformCanvas title="原始 + 频带" series={combined} height={380} />
    </div>
  );
}

function deriveBandSeries(values: TimedValue[], settings: EegSettings): WaveformSeries[] {
  const definitions = createEegBands();
  return definitions.map((definition) => {
    const range = settings.bandRanges[definition.key] ?? { low: definition.low, high: definition.high };
    const filter = Biquad.bandpass(range.low, range.high, 100);
    return {
      label: definition.label,
      color: definition.color,
      values: values.map((point) => ({
        timestamp: point.timestamp,
        value: filter.process(point.value)
      }))
    };
  });
}

function averageAbs(values: TimedValue[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, item) => sum + Math.abs(item.value), 0) / values.length;
}
