import { useEffect, useMemo, useRef, useState,type ReactNode } from 'react';
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
  resolveDebugScale,
  type DebugEegFilterMode,
  type DebugEegScale
} from '../domain/debug-signal';
import {
  FilterChain,
  StreamingFilterCache,
  type TimedValue
} from '../domain/dsp';
import { formatRecordingDuration } from '../domain/recording-time';
import type { LinkQualitySnapshot } from '../domain/link-quality';
import { eegTimeWindowOptions, type AutoNumber, type EegChannel, type EegSettings } from '../domain/settings';
import type { SleepDeltaArtifactContext } from '../domain/delta-artifact-filter';
import { useNativeBandWaveforms, useRobustEegAnalysis } from '../hooks/useRobustEegAnalysis';
import { BandShareChart } from './BandShareChart';
import type { DebugBlinkTrial, DebugMarkerRecord } from './DebugModeView';
import { SpectrumChart } from './SpectrumChart';
import { ThemedSelect } from './ThemedSelect';
import { WaveformCanvas } from './WaveformCanvas';
import {createPageDisplayProcessor,type PageFilter} from '../domain/page-filters';

interface AcquisitionModeViewProps {
  displayFilter?:PageFilter;
  embedded?:boolean;
  externalTools?:ReactNode;
  eegBuffers: Record<EegChannel, TimedValue[]>;
  analysisBuffers?: Record<EegChannel, TimedValue[]>;
  artifactContext?: SleepDeltaArtifactContext;
  eegSettings: EegSettings;
  connected: boolean;
  deviceName: string;
  linkStatus: string;
  sampleCount: number;
  sampleRateHz: number;
  acquisitionSampleRateHz: number;
  invalidSampleCount: number;
  linkQuality?: LinkQualitySnapshot;
  recording: boolean;
  recordingPending: boolean;
  recordingElapsedSeconds: number;
  sleepPreventionActive: boolean;
  sleepPreventionSupported: boolean;
  recordPath: string;
  markerPath: string;
  markerStatus: string;
  markers: DebugMarkerRecord[];
  blinkTrial: DebugBlinkTrial | null;
  participantId: string;
  onParticipantIdChange: (value: string) => void;
  onSelectedChannelChange: (channel: EegChannel) => void;
  onTimeWindowChange?: (seconds: AutoNumber) => void;
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

type AcquisitionAnalysisView = 'spectrum' | 'bands';

const ACQUISITION_ANALYSIS_OPTIONS = [
  { value: 'spectrum', label: '实时频谱' },
  { value: 'bands', label: '频带波形' }
];

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

export function AcquisitionModeView({
  displayFilter,
  embedded=false,
  externalTools,
  eegBuffers,
  analysisBuffers,
  artifactContext,
  eegSettings,
  connected,
  deviceName,
  linkStatus,
  sampleCount,
  sampleRateHz,
  acquisitionSampleRateHz,
  invalidSampleCount,
  linkQuality,
  recording,
  recordingPending,
  recordingElapsedSeconds,
  sleepPreventionActive,
  sleepPreventionSupported,
  recordPath,
  markerPath,
  markerStatus,
  markers,
  blinkTrial,
  participantId,
  onParticipantIdChange,
  onSelectedChannelChange,
  onTimeWindowChange,
  onToggleRecording,
  onAddMarker,
  onStartAlignment
}: AcquisitionModeViewProps) {
  const [note, setNote] = useState('');
  const [localFilterMode, setFilterMode] = useState<DebugEegFilterMode>('0.5-30');
  const filterMode=embedded?eegSettings.displayFilterMode??'0.5-30':localFilterMode;
  const [eegScale, setEegScale] = useState<DebugEegScale>('5000');
  const [analysisView, setAnalysisView] = useState<AcquisitionAnalysisView>('spectrum');
  const [inspectorTab,setInspectorTab]=useState<'analysis'|'markers'|'external'>(externalTools?'external':'analysis');
  const hasExternalTools=!!externalTools;
  useEffect(()=>setInspectorTab(tab=>hasExternalTools?'external':tab==='external'?'analysis':tab),[hasExternalTools]);
  const [now, setNow] = useState(Date.now());
  const displayFilters = useRef(EEG_CHANNELS.map(() => new StreamingFilterCache()));

  useEffect(() => {
    if (blinkTrial?.status !== 'active') return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [blinkTrial?.status]);

  const displayedEeg = useMemo(() => Object.fromEntries(
    EEG_CHANNELS.map(({ key },index) => [
      key,
      displayFilters.current[index].update(`${key}|${JSON.stringify(displayFilter??filterMode)}|${sampleRateHz}`,eegBuffers[key],()=>{
        if(displayFilter)return createPageDisplayProcessor(displayFilter,sampleRateHz);
        const [low,high,order]=filterMode==='8-13'?[8,13,4] as const:filterMode==='0.7-15'?[0.7,15,2] as const:[0.5,30,4] as const;
        const chain=filterMode==='raw'?null:FilterChain.butterworthBandpass({low,high,order,sampleRate:sampleRateHz});
        let offset:number|null=null;
        return {process(value:number){offset??=value;return chain?chain.process(value-offset):value-offset;},reset(){chain?.reset();offset=null;}};
      })
    ])
  ) as Record<EegChannel, TimedValue[]>, [eegBuffers, filterMode, sampleRateHz,displayFilter]);

  const selectedValues = eegBuffers[eegSettings.selectedChannel];
  const analysis=useRobustEegAnalysis(`acquisition|${eegSettings.selectedChannel}`,
    analysisBuffers?.[eegSettings.selectedChannel]??selectedValues,sampleRateHz,eegSettings,artifactContext,inspectorTab==='analysis');
  const bandSeries=useNativeBandWaveforms(`acquisition|${eegSettings.selectedChannel}`,
    inspectorTab==='analysis'&&analysisView==='bands'?selectedValues:[],sampleRateHz,eegSettings,analysis.artifactIntervals);

  const lossRate = linkQuality?.ready
    ? linkQuality.lossRatePercent / 100
    : sampleCount > 0 ? invalidSampleCount / sampleCount : 0;
  const alignmentRemaining = blinkTrial?.status === 'active'
    ? Math.max(0, blinkTrial.endsAt - now)
    : 0;

  return (
    <div className="acquisition-mode" aria-label="数据采集模式界面">
      {embedded&&<span className="sr-only">音乐、基线、分期和眨眼控制均已停用</span>}
      {!embedded&&<header className="debug-toolbar panel acquisition-toolbar">
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
          <span>{linkQuality?.ready
            ? `10s 实收 ${linkQuality.effectiveSampleRateHz.toFixed(1)}/${acquisitionSampleRateHz === 1_000 ? '1 kHz' : `${acquisitionSampleRateHz} Hz`}`
            : `目标 ${acquisitionSampleRateHz === 1_000 ? '1 kHz' : `${acquisitionSampleRateHz} Hz`}`}</span>
          <span>{linkQuality?.ready ? '10s ' : '累计 '}丢包 {formatPercent(lossRate)}</span>
          <span data-state={sleepPreventionActive ? 'ready' : 'idle'}>
            {sleepPreventionSupported
              ? sleepPreventionActive ? '整夜保护 已开启' : '整夜保护 待机'
              : '整夜保护 Windows 专用'}
          </span>
          <button type="button" className={recording ? 'is-recording' : ''} onClick={onToggleRecording} disabled={recordingPending}>
            {recording ? <CircleStop size={15} /> : <Play size={15} />}
            {recordingPending ? '处理中…' : recording ? `停止记录 ${formatRecordingDuration(recordingElapsedSeconds)}` : '开始记录'}
          </button>
        </div>
      </header>}

      {!embedded&&<div className="debug-display-controls panel acquisition-controls">
        <label>
          <span>四通道显示滤波</span>
          <ThemedSelect
            ariaLabel="采集 EEG 显示滤波"
            value={filterMode}
            options={debugEegFilterOptions}
            onChange={(value) => setFilterMode(value as DebugEegFilterMode)}
          />
        </label>
        {!embedded&&<label>
          <span>EEG 量程</span>
          <ThemedSelect
            ariaLabel="采集 EEG 量程"
            value={eegScale}
            options={debugEegScaleOptions}
            onChange={(value) => setEegScale(value as DebugEegScale)}
          />
        </label>}
        {!embedded&&<label>
          <span>显示时间窗</span>
          <ThemedSelect ariaLabel="采集显示时间窗" value={String(eegSettings.timeWindowSeconds)} options={eegTimeWindowOptions}
            onChange={value=>onTimeWindowChange?.(value==='auto'?'auto':Number(value))}/>
        </label>}
        {!embedded&&<label>
          <span>分析通道</span>
          <ThemedSelect
            ariaLabel="采集分析通道"
            value={eegSettings.selectedChannel}
            options={EEG_CHANNEL_OPTIONS}
            onChange={(value) => onSelectedChannelChange(value as EegChannel)}
          />
        </label>}
        {!embedded&&<label>
          <span>分析显示</span>
          <ThemedSelect
            ariaLabel="采集分析显示"
            value={analysisView}
            options={ACQUISITION_ANALYSIS_OPTIONS}
            onChange={(value) => setAnalysisView(value as AcquisitionAnalysisView)}
          />
        </label>}
        <div className="debug-link-summary">
          <span>{linkStatus}</span>
          <span>信号时基 <strong>{sampleRateHz} Hz</strong> · 屏幕按像素保峰绘制</span>
          <span>睡眠/音乐控制 <strong>已关闭</strong></span>
        </div>
      </div>}

      <div className="debug-body acquisition-body">
        <section className="debug-waveforms acquisition-eeg-waveforms" data-view="eeg" aria-label="四通道原始 EEG">
          {EEG_CHANNELS.map(({ key, color }) => (
            <WaveformCanvas
              key={key}
              title={`${key.toUpperCase()} · ${displayFilter?displayFilter.enabled?`显示 ${displayFilter.low}–${displayFilter.high} Hz`:'原始（未滤波）':debugEegFilterOptions.find((item) => item.value === filterMode)?.label}`}
              series={[{
                label: key.toUpperCase(),
                color,
                values: displayedEeg[key],
                scale: embedded?typeof eegSettings.scale==='number'?eegSettings.scale:undefined:resolveDebugScale(eegScale)
              }]}
              fill
            />
          ))}
        </section>

        <aside className="debug-inspector acquisition-inspector" aria-label="采集分析与事件标记">
          {embedded&&<nav className="inspector-tabs" role="tablist" aria-label="采集工具">
            <button role="tab" aria-selected={inspectorTab==='analysis'} onClick={()=>setInspectorTab('analysis')}>信号分析</button>
            <button role="tab" aria-selected={inspectorTab==='markers'} onClick={()=>setInspectorTab('markers')}>事件标记</button>
            {externalTools&&<button role="tab" aria-selected={inspectorTab==='external'} onClick={()=>setInspectorTab('external')}>外部接入</button>}
          </nav>}
          {externalTools&&<section className="external-tools" hidden={embedded&&inspectorTab!=='external'}>{externalTools}</section>}
          <section className="debug-section panel acquisition-band-section acquisition-analysis-section" hidden={embedded&&inspectorTab!=='analysis'}>
            {embedded&&<div className="inspector-controls"><ThemedSelect ariaLabel="采集分析通道" value={eegSettings.selectedChannel} options={EEG_CHANNEL_OPTIONS}
              onChange={value=>onSelectedChannelChange(value as EegChannel)}/>
              <ThemedSelect ariaLabel="采集分析显示" value={analysisView} options={ACQUISITION_ANALYSIS_OPTIONS}
              onChange={value=>setAnalysisView(value as AcquisitionAnalysisView)}/></div>}
            <header>
              <span>{analysisView === 'spectrum' ? <Activity size={14} /> : <Waves size={14} />}</span>
              <strong>
                {eegSettings.selectedChannel.toUpperCase()} · {analysisView === 'spectrum'
                  ? '实时频谱'
                  : '四频带 · 因果 Butterworth 带通'}
              </strong>
            </header>
            <div className={`debug-section-body ${analysisView === 'spectrum' ? 'acquisition-spectrum-body' : 'acquisition-band-stack'}`}>
              {analysisView === 'spectrum' ? (
                <SpectrumChart
                  values={selectedValues}
                  sampleRateHz={sampleRateHz}
                  channelLabel={eegSettings.selectedChannel.toUpperCase()}
                  analysis={analysis}
                />
              ) : bandSeries.map((band) => (
                <div className="acquisition-band-chart" key={band.label}>
                  <WaveformCanvas
                    title={`${band.label} · ${band.range}`}
                    series={[band]}
                    height={132}
                    gridStyle="dots"
                  />
                </div>
              ))}
            </div>
            <BandShareChart shares={analysis.displayShares??analysis.shares} colors={{Delta:'#1d4ed8',Theta:'#7dd3fc',Alpha:'#f59e0b',Beta:'#ef4444'}}
              mode={analysis.displayShares?'untrusted_preview':'welch_relative_power'} qualityLabel={`${analysis.reason} · 控制有效${Math.round(analysis.cleanFraction*100)}%${analysis.held&&!analysis.displayShares?' · 保持上次有效占比':''}`}/>
          </section>

          <section className="debug-section panel acquisition-marker-panel" aria-label="事件标记栏" hidden={embedded&&inspectorTab!=='markers'}>
            <header><span><Flag size={14} /></span><strong>事件标记</strong></header>
            <div className="debug-section-body acquisition-marker-body">
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
          </section>
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
