import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CircleStop,
  Flag,
  Play,
  Save,
  TimerReset,
  Waves
} from 'lucide-react';
import {
  debugEegFilterOptions,
  debugEegScaleOptions,
  filterDebugEegWindow,
  resolveDebugScale,
  type DebugEegFilterMode,
  type DebugEegScale
} from '../domain/debug-signal';
import {
  createEegBands,
  FilterChain,
  StreamingFilterCache,
  type TimedValue
} from '../domain/dsp';
import { formatRecordingDuration } from '../domain/recording-time';
import type { EegChannel, EegSettings } from '../domain/settings';
import type { DebugBlinkTrial, DebugMarkerRecord } from './DebugModeView';
import { ThemedSelect } from './ThemedSelect';
import { WaveformCanvas } from './WaveformCanvas';

interface AcquisitionModeViewProps {
  eegBuffers: Record<EegChannel, TimedValue[]>;
  eegSettings: EegSettings;
  connected: boolean;
  deviceName: string;
  linkStatus: string;
  sampleCount: number;
  sampleRateHz: number;
  acquisitionSampleRateHz: number;
  invalidSampleCount: number;
  recording: boolean;
  recordingPending: boolean;
  recordingElapsedSeconds: number;
  recordPath: string;
  markerPath: string;
  markerStatus: string;
  markers: DebugMarkerRecord[];
  blinkTrial: DebugBlinkTrial | null;
  participantId: string;
  onParticipantIdChange: (value: string) => void;
  onSelectedChannelChange: (channel: EegChannel) => void;
  onToggleRecording: () => void;
  onAddMarker: (label: string, note: string) => void;
  onStartAlignment: () => void;
}

const EEG_CHANNELS: Array<{ key: EegChannel; color: string }> = [
  { key: 'eeg1', color: '#38bdf8' },
  { key: 'eeg2', color: '#818cf8' },
  { key: 'eeg3', color: '#2dd4bf' },
  { key: 'eeg4', color: '#f59e0b' }
];

const EEG_CHANNEL_OPTIONS = EEG_CHANNELS.map(({ key }) => ({
  value: key,
  label: key.toUpperCase()
}));

const ACQUISITION_MARKERS = [
  '睁眼',
  '闭眼',
  '自然眨眼',
  '运动伪迹',
  '体位改变',
  '电极调整',
  '清醒 KSS≤3',
  '困倦 KSS≥7'
];

const BANDS = createEegBands();

export function AcquisitionModeView({
  eegBuffers,
  eegSettings,
  connected,
  deviceName,
  linkStatus,
  sampleCount,
  sampleRateHz,
  acquisitionSampleRateHz,
  invalidSampleCount,
  recording,
  recordingPending,
  recordingElapsedSeconds,
  recordPath,
  markerPath,
  markerStatus,
  markers,
  blinkTrial,
  participantId,
  onParticipantIdChange,
  onSelectedChannelChange,
  onToggleRecording,
  onAddMarker,
  onStartAlignment
}: AcquisitionModeViewProps) {
  const [note, setNote] = useState('');
  const [filterMode, setFilterMode] = useState<DebugEegFilterMode>('0.5-30');
  const [eegScale, setEegScale] = useState<DebugEegScale>('5000');
  const [now, setNow] = useState(Date.now());
  const bandFilters = useRef(BANDS.map(() => new StreamingFilterCache()));

  useEffect(() => {
    if (blinkTrial?.status !== 'active') return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [blinkTrial?.status]);

  const displayedEeg = useMemo(() => Object.fromEntries(
    EEG_CHANNELS.map(({ key }) => [
      key,
      filterDebugEegWindow(eegBuffers[key], filterMode, sampleRateHz)
    ])
  ) as Record<EegChannel, TimedValue[]>, [eegBuffers, filterMode, sampleRateHz]);

  const selectedValues = eegBuffers[eegSettings.selectedChannel];
  const bandSeries = useMemo(() => BANDS.map((band, index) => {
    const range = eegSettings.bandRanges[band.key] ?? { low: band.low, high: band.high };
    const values = bandFilters.current[index].update(
      `acquisition|${eegSettings.selectedChannel}|${band.key}|${range.low}|${range.high}|${eegSettings.notch}|${sampleRateHz}`,
      selectedValues,
      () => FilterChain.firBandpass({
        low: range.low,
        high: range.high,
        sampleRate: sampleRateHz,
        notch: eegSettings.notch
      })
    );
    return {
      label: band.label,
      color: band.color,
      values,
      range: `${range.low}-${range.high} Hz`
    };
  }), [eegSettings.bandRanges, eegSettings.notch, eegSettings.selectedChannel, sampleRateHz, selectedValues]);

  const lossRate = sampleCount > 0 ? invalidSampleCount / sampleCount : 0;
  const alignmentRemaining = blinkTrial?.status === 'active'
    ? Math.max(0, blinkTrial.endsAt - now)
    : 0;

  return (
    <div className="acquisition-mode" aria-label="数据采集模式界面">
      <header className="debug-toolbar panel acquisition-toolbar">
        <div className="debug-toolbar-title">
          <Activity size={18} />
          <span>
            <strong>数据采集模式</strong>
            <small>仅采集、显示、记录与人工标记；音乐、基线、分期和眨眼控制均已停用</small>
          </span>
        </div>
        <div className="debug-toolbar-status">
          <span data-state={connected ? 'ready' : 'idle'}>{connected ? `已连接 ${deviceName}` : 'BLE 未连接'}</span>
          <span>{sampleCount} samples</span>
          <span>{acquisitionSampleRateHz === 1_000 ? '1 kHz' : `${acquisitionSampleRateHz} Hz`}</span>
          <span>丢包 {formatPercent(lossRate)}</span>
          <button type="button" className={recording ? 'is-recording' : ''} onClick={onToggleRecording} disabled={recordingPending}>
            {recording ? <CircleStop size={15} /> : <Play size={15} />}
            {recordingPending ? '处理中…' : recording ? `停止记录 ${formatRecordingDuration(recordingElapsedSeconds)}` : '开始记录'}
          </button>
        </div>
      </header>

      <div className="debug-display-controls panel acquisition-controls">
        <label>
          <span>四通道显示滤波</span>
          <ThemedSelect
            ariaLabel="采集 EEG 显示滤波"
            value={filterMode}
            options={debugEegFilterOptions}
            onChange={(value) => setFilterMode(value as DebugEegFilterMode)}
          />
        </label>
        <label>
          <span>EEG 量程</span>
          <ThemedSelect
            ariaLabel="采集 EEG 量程"
            value={eegScale}
            options={debugEegScaleOptions}
            onChange={(value) => setEegScale(value as DebugEegScale)}
          />
        </label>
        <label>
          <span>频带分析通道</span>
          <ThemedSelect
            ariaLabel="采集频带分析通道"
            value={eegSettings.selectedChannel}
            options={EEG_CHANNEL_OPTIONS}
            onChange={(value) => onSelectedChannelChange(value as EegChannel)}
          />
        </label>
        <div className="debug-link-summary">
          <span>{linkStatus}</span>
          <span>绘图处理 <strong>{sampleRateHz} Hz</strong></span>
          <span>算法链路 <strong>已关闭</strong></span>
        </div>
      </div>

      <div className="acquisition-body">
        <section className="acquisition-waveform-column" aria-label="四通道原始 EEG">
          <header><Activity size={13} /><strong>四通道 EEG</strong><span>{debugEegFilterOptions.find((item) => item.value === filterMode)?.label}</span></header>
          <div className="acquisition-waveform-stack">
            {EEG_CHANNELS.map(({ key, color }) => (
              <WaveformCanvas
                key={key}
                title={`${key.toUpperCase()} · 采集波形`}
                series={[{
                  label: key.toUpperCase(),
                  color,
                  values: displayedEeg[key],
                  scale: resolveDebugScale(eegScale)
                }]}
                fill
              />
            ))}
          </div>
        </section>

        <section className="acquisition-waveform-column" aria-label="所选通道四频带">
          <header><Waves size={13} /><strong>{eegSettings.selectedChannel.toUpperCase()} 四频带</strong><span>独立 FIR 带通</span></header>
          <div className="acquisition-waveform-stack">
            {bandSeries.map((band) => (
              <WaveformCanvas
                key={band.label}
                title={`${band.label} · ${band.range}`}
                sideLabel={{ text: band.label, color: band.color, sub: band.range }}
                series={[band]}
              />
            ))}
          </div>
        </section>

        <aside className="acquisition-marker-panel panel" aria-label="事件标记栏">
          <header><Flag size={14} /><strong>事件标记</strong></header>
          <div className="acquisition-marker-body">
            <label className="debug-participant-id">
              <span>匿名受试者 ID</span>
              <input
                value={participantId}
                maxLength={32}
                placeholder="例如 P001"
                onChange={(event) => onParticipantIdChange(event.target.value)}
                disabled={recording}
              />
            </label>
            <button
              type="button"
              className="acquisition-alignment-button"
              disabled={!recording || blinkTrial?.status === 'active'}
              onClick={onStartAlignment}
            >
              <TimerReset size={13} />PSG 对齐：连续眨眼 10 秒
            </button>
            {blinkTrial?.expectedCount === 'continuous' && (
              <div className="debug-trial-status" data-state={blinkTrial.status === 'active' ? 'active' : 'ready'}>
                <strong>{blinkTrial.status === 'active'
                  ? `连续眨眼中 · 剩余 ${(alignmentRemaining / 1000).toFixed(1)} 秒`
                  : 'PSG 对齐标记已完成'}</strong>
                <span>开始与结束时间均写入标记文件</span>
              </div>
            )}
            <div className="debug-marker-buttons acquisition-marker-buttons">
              {ACQUISITION_MARKERS.map((label) => (
                <button key={label} type="button" disabled={!recording} onClick={() => onAddMarker(label, note)}>
                  <Flag size={12} />{label}
                </button>
              ))}
            </div>
            <label className="debug-note">
              备注
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="事件、动作、佩戴或接触状态" />
            </label>
            <button type="button" className="debug-custom-marker" disabled={!recording || !note.trim()} onClick={() => onAddMarker('自定义标记', note)}>
              <Save size={13} />保存自定义标记
            </button>
            <div className="debug-paths">
              <span>数据文件<code>{recordPath || '--'}</code></span>
              <span>标记文件<code>{markerPath || '--'}</code></span>
              <small>{markerStatus}</small>
            </div>
            <div className="debug-event-log acquisition-event-log" aria-label="采集事件日志">
              {markers.length === 0 ? <span>等待人工标记</span> : markers.slice(-12).reverse().map((marker) => (
                <div key={`${marker.timestamp}-${marker.sampleCount}-${marker.label}`} data-kind="marker">
                  <time>{formatClock(marker.timestamp)}</time>
                  <strong>{marker.label}</strong>
                  <small>sample {marker.sampleCount}{marker.note ? ` · ${marker.note}` : ''}</small>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

function formatClock(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? '--:--:--'
    : parsed.toLocaleTimeString('zh-CN', { hour12: false });
}
