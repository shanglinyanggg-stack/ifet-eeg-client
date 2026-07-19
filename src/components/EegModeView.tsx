import { useEffect, useMemo, useRef } from 'react';
import {
  FilterChain,
  StreamingFilterCache,
  computeShare,
  createEegBands,
  resolveScale,
  EEG_SAMPLE_RATE,
  type BandShare,
  type EegBandDefinition,
  type TimedValue
} from '../domain/dsp';
import { calculateSleepMetrics, type SleepMetrics } from '../domain/sleep-metrics';
import { cleanSleepDeltaWave } from '../domain/delta-artifact-filter';
import type { EegChannel, EegSettings } from '../domain/settings';
import { WaveformCanvas, type WaveformSeries } from './WaveformCanvas';
import { BandShareChart } from './BandShareChart';
import { SleepMetricsPanel } from './SleepMetricsPanel';
import { SleepTrendChart } from './SleepTrendChart';
import {
  SleepMusicPanel,
  resolveRealtimeStage,
  type SleepMusicPanelProps
} from './SleepMusicPanel';

interface EegModeViewProps {
  channel: EegChannel;
  values: TimedValue[];
  settings: EegSettings;
  onSleepMetrics?: (metrics: SleepMetrics) => void;
  musicPanel?: Omit<SleepMusicPanelProps, 'variant' | 'metrics'>;
}

const BAND_DEFINITIONS = createEegBands();

export function EegModeView({ channel, values, settings, onSleepMetrics, musicPanel }: EegModeViewProps) {
  const bandSeries = useBandFilters(BAND_DEFINITIONS, channel, values, settings);
  const spindleValues = useSpindleFilter(channel, values, settings);
  const rawValues = useRawWaveformFilter(channel, values, settings);
  const rawScale = resolveScale(settings.scale, rawValues.map((item) => item.value));
  const shareValues = computeShare(
    bandSeries.map((band) => ({
      label: band.label as BandShare['label'],
      value: averageAbs(band.values)
    }))
  );
  const bandColors = Object.fromEntries(bandSeries.map((band) => [band.label, band.color]));
  const sleepMetrics = useMemo(() => calculateSleepMetrics({
    rawValues: values,
    bands: bandSeries.map((band) => ({
      label: band.label as BandShare['label'],
      values: band.values
    })),
    spindleValues
  }), [bandSeries, spindleValues, values]);
  const stagingResponse = musicPanel?.serviceStatus?.lastResponse ?? null;

  useEffect(() => {
    onSleepMetrics?.(sleepMetrics);
  }, [onSleepMetrics, sleepMetrics]);

  return (
    <div className="eeg-layout">
      <WaveformCanvas title={`${channel.toUpperCase()} 原始波形`} series={[{ label: channel.toUpperCase(), color: 'var(--wave-raw)', values: rawValues, scale: rawScale }]} fill />
      <div className="eeg-overview-grid">
        <BandShareChart shares={shareValues} colors={bandColors} />
        <SleepTrendChart
          metrics={sleepMetrics}
          sleepProbability={stagingResponse?.decision_valid ? stagingResponse.selected_sleep_probability : null}
          realtimeStage={resolveRealtimeStage(musicPanel?.serviceStatus?.phase, stagingResponse)}
        />
      </div>
      <div className="eeg-band-stack" role="group" aria-label="频带分离">
        {bandSeries.map((band, index) => (
          <WaveformCanvas
            key={band.label}
            title={`${band.label} 频带`}
            sideLabel={{
              text: band.label,
              color: band.color,
              sub: bandRangeText(BAND_DEFINITIONS[index], settings)
            }}
            series={[band]}
          />
        ))}
      </div>
      <div className="eeg-insight-stack">
        {musicPanel && <SleepMusicPanel {...musicPanel} metrics={sleepMetrics} variant="compact" />}
        <SleepMetricsPanel metrics={sleepMetrics} />
      </div>
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
  const filters = useRef<StreamingFilterCache[]>([]);
  if (filters.current.length !== definitions.length) {
    filters.current = definitions.map(() => new StreamingFilterCache());
  }

  return useMemo(() => definitions.map((definition, index) => {
    const range = settings.bandRanges[definition.key] ?? { low: definition.low, high: definition.high };
    const key = `${channel}|${definition.key}|${range.low}|${range.high}|${settings.notch}`;
    const cache = filters.current[index];
    const filtered = cache.update(key, values, () =>
      // Kaiser 窗 FIR：阻带 ~-61dB，相邻频带（如 δ/θ 的 4Hz）几乎不互相渗漏
      FilterChain.firBandpass({
        low: range.low,
        high: range.high,
        sampleRate: EEG_SAMPLE_RATE,
        notch: settings.notch
      })
    );
    return {
      label: definition.label,
      color: definition.color,
      values: definition.key === 'delta'
        ? cleanSleepDeltaWave(filtered, values, EEG_SAMPLE_RATE)
        : filtered
    };
  }), [channel, definitions, settings.bandRanges, settings.notch, values]);
}

function useSpindleFilter(channel: EegChannel, values: TimedValue[], settings: EegSettings): TimedValue[] {
  const filter = useRef(new StreamingFilterCache());
  return useMemo(() => {
    const key = `${channel}|sigma|11|16|${settings.notch}`;
    return filter.current.update(key, values, () =>
      FilterChain.firBandpass({
        low: 11,
        high: 16,
        sampleRate: EEG_SAMPLE_RATE,
        notch: settings.notch
      })
    );
  }, [channel, settings.notch, values]);
}

// 原始波形的「EEG 带通」显示滤波：仅在设置开启时生效，与频带分离一样走增量缓存
function useRawWaveformFilter(channel: EegChannel, values: TimedValue[], settings: EegSettings): TimedValue[] {
  const filter = useRef(new StreamingFilterCache());
  return useMemo(() => {
    const enabled = settings.bandpassEnabled && settings.bandpassHigh > settings.bandpassLow;
    if (!enabled) {
      filter.current.reset();
      return values;
    }
    const key = `${channel}|raw|${settings.bandpassLow}-${settings.bandpassHigh}`;
    return filter.current.update(key, values, () =>
      FilterChain.butterworthBandpass({
        low: settings.bandpassLow,
        high: settings.bandpassHigh,
        sampleRate: EEG_SAMPLE_RATE,
        order: 2
      })
    );
  }, [channel, settings.bandpassEnabled, settings.bandpassLow, settings.bandpassHigh, values]);
}

function averageAbs(values: TimedValue[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, item) => sum + Math.abs(item.value), 0) / values.length;
}

function bandRangeText(definition: EegBandDefinition, settings: EegSettings): string {
  const range = settings.bandRanges[definition.key] ?? { low: definition.low, high: definition.high };
  return `${range.low}-${range.high} Hz`;
}
