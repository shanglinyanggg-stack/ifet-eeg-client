import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity,
  LayoutGrid,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
  X
} from 'lucide-react';
import {
  FilterChain,
  StreamingFilterCache,
  EEG_SAMPLE_RATE,
  createEegBands,
  createPureBands,
  resolveScale,
  type PureBandDefinition,
  type TimedValue
} from '../domain/dsp';
import { calculateSleepMetrics, type SleepMetrics } from '../domain/sleep-metrics';
import {
  eegScaleOptions,
  eegTimeWindowOptions,
  type AppSettings,
  type AutoNumber,
  type EegChannel,
  type EegPureBandKey
} from '../domain/settings';
import { channelLabels } from '../domain/protocol';
import { WaveformCanvas } from './WaveformCanvas';
import { BandDonut, type DonutShare } from './BandDonut';
import { SleepMetricsPanel } from './SleepMetricsPanel';
import { SleepTrendChart } from './SleepTrendChart';
import { ThemedSelect } from './ThemedSelect';
import {
  SleepMusicPanel,
  type SleepMusicPanelProps
} from './SleepMusicPanel';

interface PureWaveformViewProps {
  values: TimedValue[];
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onExit: () => void;
  onToggleFullscreen: () => void;
  connected: boolean;
  status: string;
  sampleCount: number;
  warmupRemaining: number;
  onSleepMetrics?: (metrics: SleepMetrics) => void;
  musicPanel?: Omit<SleepMusicPanelProps, 'variant' | 'metrics'>;
}

const EEG_CHANNEL_OPTIONS = [
  { value: 'eeg1', label: 'EEG1' },
  { value: 'eeg2', label: 'EEG2' },
  { value: 'eeg3', label: 'EEG3' },
  { value: 'eeg4', label: 'EEG4' }
];

const NOTCH_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: '50', label: '50 Hz' },
  { value: '60', label: '60 Hz' }
];

export function PureWaveformView({
  values,
  settings,
  onChange,
  onExit,
  onToggleFullscreen,
  connected,
  status,
  sampleCount,
  warmupRemaining,
  onSleepMetrics,
  musicPanel
}: PureWaveformViewProps) {
  const [bandPopoverOpen, setBandPopoverOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const eeg = settings.eeg;
  const bands = useMemo(() => createPureBands(), []);
  const sleepBands = useMemo(() => createEegBands(), []);
  const channel = eeg.selectedChannel;
  const channelLabel = channelLabels[channel] ?? channel.toUpperCase();
  const bandFilterCaches = useRef<StreamingFilterCache[]>([]);
  const sleepBandFilterCaches = useRef<StreamingFilterCache[]>([]);
  const spindleFilterCache = useRef(new StreamingFilterCache());
  const rawFilterCache = useRef(new StreamingFilterCache());
  if (bandFilterCaches.current.length !== bands.length) {
    bandFilterCaches.current = bands.map(() => new StreamingFilterCache());
  }
  if (sleepBandFilterCaches.current.length !== sleepBands.length) {
    sleepBandFilterCaches.current = sleepBands.map(() => new StreamingFilterCache());
  }

  // Esc：先关频带浮层，再退出纯波形
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (bandPopoverOpen) {
        setBandPopoverOpen(false);
        return;
      }
      onExit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bandPopoverOpen, onExit]);

  const updateEeg = (patch: Partial<typeof settings.eeg>) =>
    onChange({ ...settings, eeg: { ...settings.eeg, ...patch } });

  // 频带分离使用增量缓存，避免滑动窗口每次从零状态重滤导致左缘瞬态和整段跳动。
  const bandSeries = useMemo(() => {
    return bands.map((band, index) => {
      const range = eeg.pure.bandRanges[band.key];
      const key = `${channel}|${band.key}|${range.low}|${range.high}|${eeg.notch}`;
      const filtered = bandFilterCaches.current[index].update(
        key,
        values,
        () => createBandFilter(range, eeg.notch)
      );
      const scale = resolveScale(eeg.pure.bandScales[band.key], filtered.map((p) => p.value));
      return { ...band, values: filtered, scale };
    });
  }, [bands, channel, values, eeg.pure.bandRanges, eeg.pure.bandScales, eeg.notch]);

  // 原始波形的「EEG 带通」显示滤波：仅在设置开启时生效
  const rawValues = useMemo(() => {
    const enabled = eeg.bandpassEnabled && eeg.bandpassHigh > eeg.bandpassLow;
    if (!enabled) {
      rawFilterCache.current.reset();
      return values;
    }
    const key = `${channel}|raw|${eeg.bandpassLow}-${eeg.bandpassHigh}`;
    return rawFilterCache.current.update(key, values, () =>
      FilterChain.firBandpass({
        low: eeg.bandpassLow,
        high: eeg.bandpassHigh,
        sampleRate: EEG_SAMPLE_RATE
      })
    );
  }, [channel, values, eeg.bandpassEnabled, eeg.bandpassLow, eeg.bandpassHigh]);

  const rawScale = useMemo(
    () => resolveScale(eeg.scale, rawValues.map((p) => p.value)),
    [rawValues, eeg.scale]
  );

  const sleepBandSeries = useMemo(() => {
    return sleepBands.map((band, index) => {
      const range = eeg.bandRanges[band.key] ?? { low: band.low, high: band.high };
      const key = `${channel}|sleep|${band.key}|${range.low}|${range.high}|${eeg.notch}`;
      return {
        label: band.label,
        values: sleepBandFilterCaches.current[index].update(
          key,
          values,
          () => createBandFilter(range, eeg.notch)
        )
      };
    });
  }, [sleepBands, channel, values, eeg.bandRanges, eeg.notch]);

  const spindleValues = useMemo(() => {
    const key = `${channel}|sleep|sigma|11|16|${eeg.notch}`;
    return spindleFilterCache.current.update(
      key,
      values,
      () => createBandFilter({ low: 11, high: 16 }, eeg.notch)
    );
  }, [channel, values, eeg.notch]);

  const sleepMetrics = useMemo(() => calculateSleepMetrics({
    rawValues: values,
    bands: sleepBandSeries,
    spindleValues
  }), [values, sleepBandSeries, spindleValues]);

  useEffect(() => {
    onSleepMetrics?.(sleepMetrics);
  }, [onSleepMetrics, sleepMetrics]);

  const shares = useMemo<DonutShare[]>(() => {
    const energies = bandSeries.map((b) => ({
      symbol: b.symbol,
      label: b.label,
      color: b.color,
      value: Math.max(0, averageAbs(b.values))
    }));
    const total = energies.reduce((sum, item) => sum + item.value, 0);
    return energies.map((item) => ({
      ...item,
      percent: total > 1e-9 ? Math.round((item.value / total) * 100) : 0
    }));
  }, [bandSeries]);

  return (
    <div className="pure-waveform-view" data-rail-open={railOpen}>
      <header className="pure-toolbar">
        <div className="pure-brand">
          <span className="pure-brand-icon">
            <Activity size={19} />
          </span>
          <div className="pure-brand-text">
            <h1>纯波形监测</h1>
            <span className={`status-chip ${connected ? 'is-online' : ''}`}>
              {sampleCount} samples
              {warmupRemaining > 0 && <em>· 预热 {warmupRemaining}s</em>}
              {status && <em>· {status}</em>}
            </span>
          </div>
        </div>

        <div className="pure-controls">
          <div className="pure-segment pure-channel-segment" role="group" aria-label="EEG 通道">
            {EEG_CHANNEL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={channel === option.value ? 'is-active' : ''}
                onClick={() => updateEeg({ selectedChannel: option.value as EegChannel })}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="pure-field">
            <span>时间窗</span>
            <ThemedSelect
              className="pure-select"
              ariaLabel="时间窗"
              value={String(eeg.timeWindowSeconds)}
              options={eegTimeWindowOptions}
              onChange={(timeWindowSeconds) => updateEeg({ timeWindowSeconds: parseAutoNumber(timeWindowSeconds) })}
            />
          </label>

          <label className="pure-field">
            <span>Scale</span>
            <ThemedSelect
              className="pure-select"
              ariaLabel="Scale"
              value={String(eeg.scale)}
              options={eegScaleOptions}
              onChange={(scale) => updateEeg({ scale: parseAutoNumber(scale) })}
            />
          </label>

          <div className="pure-field pure-popover-host">
            <button
              type="button"
              className="icon-button"
              aria-expanded={bandPopoverOpen}
              onClick={() => setBandPopoverOpen((value) => !value)}
              title="频带参数"
            >
              <SlidersHorizontal size={16} />
              <span>频带参数</span>
            </button>
            {bandPopoverOpen && (
              <BandParamsPopover
                settings={settings}
                onChange={onChange}
                onClose={() => setBandPopoverOpen(false)}
              />
            )}
          </div>

          <button type="button" className="icon-button" onClick={onToggleFullscreen} title="全屏 (F11)">
            <Maximize2 size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setRailOpen((value) => !value)}
            title={railOpen ? '收起数据面板' : '展开数据面板'}
            aria-expanded={railOpen}
          >
            {railOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
          <button type="button" className="icon-button pure-exit" onClick={onExit} title="退出纯波形 (Esc)">
            <LayoutGrid size={16} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <div className="pure-body">
        <section className="pure-stage">
          <div className="pure-raw">
            <WaveformCanvas
              title={`${channelLabel} 原始波形`}
              series={[{ label: channelLabel, color: 'var(--wave-raw)', values: rawValues, scale: rawScale }]}
              fill
            />
          </div>
          <div className="pure-bands">
            {bandSeries.map((band) => (
              <WaveformCanvas
                key={band.key}
                title={`${band.label} 频带`}
                sideLabel={{
                  text: band.symbol,
                  color: band.color,
                  sub: `${band.label} · ${bandRangeText(band, eeg.pure.bandRanges[band.key])}`
                }}
                gridStyle="dots"
                series={[{ label: band.label, color: band.color, values: band.values, scale: band.scale }]}
              />
            ))}
          </div>
        </section>

        <aside className="pure-rail" aria-label="数据面板">
          <div className="pure-rail-content">
            <BandDonut shares={shares} />
            <SleepTrendChart metrics={sleepMetrics} />
            {musicPanel && (
              <div className="pure-sleep-music">
                <SleepMusicPanel {...musicPanel} metrics={sleepMetrics} />
              </div>
            )}
            <div className="pure-sleep-metrics">
              <SleepMetricsPanel metrics={sleepMetrics} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// 频带参数浮层：4 个纯波形频带的滤波范围 + 独立 scale + 陷波
function BandParamsPopover({
  settings,
  onChange,
  onClose
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
}) {
  const bands = useMemo(() => createPureBands(), []);
  const eeg = settings.eeg;

  const updateBandRange = (key: EegPureBandKey, side: 'low' | 'high', value: number) => {
    onChange({
      ...settings,
      eeg: {
        ...settings.eeg,
        pure: {
          ...settings.eeg.pure,
          bandRanges: {
            ...settings.eeg.pure.bandRanges,
            [key]: { ...settings.eeg.pure.bandRanges[key], [side]: value }
          }
        }
      }
    });
  };

  const updateBandScale = (key: EegPureBandKey, value: AutoNumber) => {
    onChange({
      ...settings,
      eeg: {
        ...settings.eeg,
        pure: {
          ...settings.eeg.pure,
          bandScales: { ...settings.eeg.pure.bandScales, [key]: value }
        }
      }
    });
  };

  const updateNotch = (value: string) => {
    const notch = value === '50' ? 50 : value === '60' ? 60 : 'off';
    onChange({ ...settings, eeg: { ...settings.eeg, notch } });
  };

  return (
    <div className="pure-popover" role="dialog" aria-label="频带参数">
      <div className="pure-popover-head">
        <span>频带参数</span>
        <button type="button" className="pure-popover-close" onClick={onClose} aria-label="关闭">
          <X size={15} />
        </button>
      </div>
      <div className="pure-popover-grid">
        <span className="pure-popover-colhead">频带</span>
        <span className="pure-popover-colhead">低 Hz</span>
        <span className="pure-popover-colhead">高 Hz</span>
        <span className="pure-popover-colhead">Scale</span>
        {bands.map((band) => {
          const range = eeg.pure.bandRanges[band.key];
          const scale = eeg.pure.bandScales[band.key];
          return (
            <div className="pure-popover-row" key={band.key} style={{ '--band-color': band.color } as CSSProperties}>
              <span className="pure-popover-band">
                <i className="pure-popover-dot" />
                {band.symbol} {band.label}
              </span>
              <input
                type="number"
                step="0.1"
                value={range.low}
                onChange={(event) => updateBandRange(band.key, 'low', Number(event.target.value))}
              />
              <input
                type="number"
                step="0.1"
                value={range.high}
                onChange={(event) => updateBandRange(band.key, 'high', Number(event.target.value))}
              />
              <ThemedSelect
                className="pure-band-scale-select"
                ariaLabel={`${band.label} Scale`}
                value={String(scale)}
                options={eegScaleOptions}
                onChange={(value) => updateBandScale(band.key, parseAutoNumber(value))}
              />
            </div>
          );
        })}
      </div>
      <div className="pure-popover-foot">
        <span>陷波</span>
        <div className="pure-segment pure-segment-sm">
          {NOTCH_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={String(eeg.notch) === option.value ? 'is-active' : ''}
              onClick={() => updateNotch(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function createBandFilter(
  range: { low: number; high: number },
  notch: 'off' | 50 | 60
): FilterChain {
  return FilterChain.firBandpass({
    low: range.low,
    high: range.high,
    sampleRate: EEG_SAMPLE_RATE,
    notch
  });
}

function averageAbs(values: TimedValue[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const item of values) sum += Math.abs(item.value);
  return sum / values.length;
}

function bandRangeText(
  band: PureBandDefinition,
  range: { low: number; high: number }
): string {
  return `${range.low}–${range.high} Hz`;
}

function parseAutoNumber(value: string): AutoNumber {
  if (value.trim().toLowerCase() === 'auto') return 'auto';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'auto';
}
