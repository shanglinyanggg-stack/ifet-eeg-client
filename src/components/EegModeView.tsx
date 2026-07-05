import { useRef } from 'react';
import {
  Biquad,
  FilterChain,
  computeShare,
  createEegBands,
  resolveScale,
  EEG_SAMPLE_RATE,
  type BandShare,
  type EegBandDefinition,
  type TimedValue
} from '../domain/dsp';
import type { EegChannel, EegSettings } from '../domain/settings';
import { WaveformCanvas, type WaveformSeries } from './WaveformCanvas';
import { BandShareChart } from './BandShareChart';

interface EegModeViewProps {
  channel: EegChannel;
  values: TimedValue[];
  settings: EegSettings;
}

const BAND_DEFINITIONS = createEegBands();

export function EegModeView({ channel, values, settings }: EegModeViewProps) {
  const bandSeries = useBandFilters(BAND_DEFINITIONS, channel, values, settings);
  const rawScale = resolveScale(settings.scale, values.map((item) => item.value));
  const shareValues = computeShare(
    bandSeries.map((band) => ({
      label: band.label as BandShare['label'],
      value: averageAbs(band.values)
    }))
  );
  const bandColors = Object.fromEntries(bandSeries.map((band) => [band.label, band.color]));
  const combined: WaveformSeries[] = [
    { label: channel.toUpperCase(), color: 'var(--wave-raw)', values, scale: rawScale },
    ...bandSeries
  ];

  return (
    <div className="eeg-layout">
      <WaveformCanvas title={`${channel.toUpperCase()} 原始波形`} series={[{ label: channel.toUpperCase(), color: 'var(--wave-raw)', values, scale: rawScale }]} fill />
      <BandShareChart shares={shareValues} colors={bandColors} />
      <WaveformCanvas title="频带分离" series={bandSeries} fill />
      <WaveformCanvas title="原始 + 频带" series={combined} fill />
    </div>
  );
}

// 频带数量固定为 4，在顶层用定长 ref 数组维护每个频带的滤波链状态。
// 仅在通道/频带范围/陷波变化时重建链，跨渲染保持状态，消除每帧重建带来的启动瞬态。
function useBandFilters(
  definitions: EegBandDefinition[],
  channel: EegChannel,
  values: TimedValue[],
  settings: EegSettings
): WaveformSeries[] {
  const filters = useRef<Array<{ key: string; chain: FilterChain }>>([]);
  if (filters.current.length !== definitions.length) {
    filters.current = definitions.map(() => ({ key: '', chain: new FilterChain([]) }));
  }

  return definitions.map((definition, index) => {
    const range = settings.bandRanges[definition.key] ?? { low: definition.low, high: definition.high };
    const key = `${channel}|${definition.key}|${range.low}|${range.high}|${settings.notch}`;
    const entry = filters.current[index];
    if (entry.key !== key) {
      const stages: Biquad[] = [Biquad.bandpass(range.low, range.high, EEG_SAMPLE_RATE)];
      if (settings.notch !== 'off') {
        stages.push(Biquad.notch(settings.notch, EEG_SAMPLE_RATE));
      }
      entry.key = key;
      entry.chain = new FilterChain(stages);
    }
    return {
      label: definition.label,
      color: definition.color,
      values: values.map((point) => ({
        timestamp: point.timestamp,
        value: entry.chain.process(point.value)
      }))
    };
  });
}

function averageAbs(values: TimedValue[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, item) => sum + Math.abs(item.value), 0) / values.length;
}
