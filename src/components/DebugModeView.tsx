import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BrainCircuit,
  Bug,
  CircleStop,
  Eye,
  Flag,
  Gauge,
  ListChecks,
  MoonStar,
  Pause,
  Play,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Volume2,
  Waves
} from 'lucide-react';
import {
  debugEegFilterOptions,
  debugEegScaleOptions,
  filterDebugEegWindow,
  resolveDebugScale,
  type DebugEegFilterMode,
  type DebugEegScale,
  type DebugSignalView
} from '../domain/debug-signal';
import type { TimedValue } from '../domain/dsp';
import type { MusicPlayerController } from '../domain/music-player';
import {
  formatEnabledBlinkPairs,
  formatReferenceStrength,
  type SleepDemoSignalResponse
} from '../domain/sleep-demo-signal';
import type { SleepSessionState } from '../domain/sleep-session';
import type { EegChannel, SleepMusicSettings } from '../domain/settings';
import type { SleepStagingStepResponse } from '../domain/sleep-staging-client';
import { ThemedSelect } from './ThemedSelect';
import { WaveformCanvas } from './WaveformCanvas';

export interface DebugMarkerRecord {
  timestamp: string;
  label: string;
  note: string;
  sampleCount: number;
}

export interface DebugAlgorithmEvent {
  timestamp: string;
  label: string;
  detail: string;
}

export interface DebugBlinkTrial {
  expectedCount: 0 | 3 | 5;
  startedAt: number;
  endsAt: number;
  detectedCount: 3 | 5 | null;
  status: 'active' | 'complete';
  success: boolean | null;
}

type PpgChannel = 'ir1' | 'red1' | 'green1' | 'ir2' | 'red2' | 'green2';

interface DebugModeViewProps {
  eegBuffers: Record<EegChannel, TimedValue[]>;
  ppgBuffers: Record<PpgChannel, TimedValue[]>;
  connected: boolean;
  deviceName: string;
  linkStatus: string;
  sampleCount: number;
  invalidSampleCount: number;
  latestDeviceFlag: number | null;
  recording: boolean;
  recordPath: string;
  markerPath: string;
  markerStatus: string;
  markers: DebugMarkerRecord[];
  algorithmEvents: DebugAlgorithmEvent[];
  algorithmAction: string | null;
  demoResponse: SleepDemoSignalResponse | null;
  demoPhase: string;
  demoMessage: string;
  stagingResponse: SleepStagingStepResponse | null;
  stagingPhase: string;
  stagingMessage: string;
  session: SleepSessionState;
  sleepSettings: SleepMusicSettings;
  player: MusicPlayerController;
  guidanceActive: boolean;
  guidanceMessage: string;
  blinkTrial: DebugBlinkTrial | null;
  participantId: string;
  onParticipantIdChange: (value: string) => void;
  onSleepSettingsChange: (patch: Partial<SleepMusicSettings>) => void;
  onOpenEyeCalibration: () => void;
  onClosedEyeCalibration: () => void;
  onBlinkCalibration: () => void;
  onStartGuidance: () => void;
  onStopGuidance: () => void;
  onStartSleepAndRecord: () => void;
  onStartBlinkValidation: () => void;
  onStopSession: () => void;
  onStartBlinkTrial: (expectedCount: 0 | 3 | 5) => void;
  onToggleRecording: () => void;
  onAddMarker: (label: string, note: string) => void;
}

const EEG_CHANNELS: Array<{ key: EegChannel; color: string }> = [
  { key: 'eeg1', color: '#38bdf8' },
  { key: 'eeg2', color: '#818cf8' },
  { key: 'eeg3', color: '#2dd4bf' },
  { key: 'eeg4', color: '#f59e0b' }
];

const MARKERS = ['单次眨眼', '眨眼误识别', '眨眼漏识别', '运动伪迹', '睁眼', '闭眼'];

export function DebugModeView({
  eegBuffers,
  ppgBuffers,
  connected,
  deviceName,
  linkStatus,
  sampleCount,
  invalidSampleCount,
  latestDeviceFlag,
  recording,
  recordPath,
  markerPath,
  markerStatus,
  markers,
  algorithmEvents,
  algorithmAction,
  demoResponse,
  demoPhase,
  demoMessage,
  stagingResponse,
  stagingPhase,
  stagingMessage,
  session,
  sleepSettings,
  player,
  guidanceActive,
  guidanceMessage,
  blinkTrial,
  participantId,
  onParticipantIdChange,
  onSleepSettingsChange,
  onOpenEyeCalibration,
  onClosedEyeCalibration,
  onBlinkCalibration,
  onStartGuidance,
  onStopGuidance,
  onStartSleepAndRecord,
  onStartBlinkValidation,
  onStopSession,
  onStartBlinkTrial,
  onToggleRecording,
  onAddMarker
}: DebugModeViewProps) {
  const [note, setNote] = useState('');
  const [signalView, setSignalView] = useState<DebugSignalView>('eeg');
  const [filterMode, setFilterMode] = useState<DebugEegFilterMode>('0.5-30');
  const [eegScale, setEegScale] = useState<DebugEegScale>('5000');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (blinkTrial?.status !== 'active') return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [blinkTrial?.status]);

  const debugEeg = useMemo(() => Object.fromEntries(
    EEG_CHANNELS.map(({ key }) => [key, filterDebugEegWindow(eegBuffers[key], filterMode)])
  ) as Record<EegChannel, TimedValue[]>, [eegBuffers, filterMode]);

  const telemetry = demoResponse?.telemetry;
  const state = demoResponse?.state;
  const lossRate = sampleCount > 0 ? invalidSampleCount / sampleCount : 0;
  const initialBaseline = telemetry?.open_eye_alpha_initial_baseline;
  const currentBaseline = telemetry?.open_eye_alpha_baseline;
  const baselineChange = initialBaseline && currentBaseline !== null && currentBaseline !== undefined
    ? (currentBaseline - initialBaseline) / Math.abs(initialBaseline)
    : null;
  const trialRemaining = blinkTrial?.status === 'active'
    ? Math.max(0, blinkTrial.endsAt - now)
    : 0;
  const disabledPairs = formatEnabledBlinkPairs(telemetry?.blink_runtime_disabled_pairs);

  return (
    <div className="debug-mode" aria-label="调试记录界面">
      <header className="debug-toolbar panel">
        <div className="debug-toolbar-title">
          <Bug size={18} />
          <span>
            <strong>EEGSleepUpper 综合调试</strong>
            <small>4 路 EEG / 6 路 PPG · Alpha、眨眼、睡眠与音乐闭环参数</small>
          </span>
        </div>
        <div className="debug-toolbar-status">
          <span data-state={connected ? 'ready' : 'idle'}>{connected ? `已连接 ${deviceName}` : 'BLE 未连接'}</span>
          <span>{sampleCount} samples</span>
          <span>丢包 {formatPercent(lossRate)}</span>
          <button type="button" className={recording ? 'is-recording' : ''} onClick={onToggleRecording}>
            {recording ? <CircleStop size={15} /> : <Play size={15} />}
            {recording ? '停止记录' : '开始记录'}
          </button>
        </div>
      </header>

      <div className="debug-display-controls panel">
        <div className="debug-segmented" aria-label="调试信号类别">
          <button type="button" className={signalView === 'eeg' ? 'is-active' : ''} onClick={() => setSignalView('eeg')}>
            <BrainCircuit size={13} />4 路 EEG
          </button>
          <button type="button" className={signalView === 'ppg' ? 'is-active' : ''} onClick={() => setSignalView('ppg')}>
            <Activity size={13} />6 路 PPG
          </button>
        </div>
        <label>
          <span>显示滤波</span>
          <ThemedSelect
            ariaLabel="调试 EEG 显示滤波"
            value={filterMode}
            options={debugEegFilterOptions}
            onChange={(value) => setFilterMode(value as DebugEegFilterMode)}
            disabled={signalView !== 'eeg'}
          />
        </label>
        <label>
          <span>EEG 量程</span>
          <ThemedSelect
            ariaLabel="调试 EEG 量程"
            value={eegScale}
            options={debugEegScaleOptions}
            onChange={(value) => setEegScale(value as DebugEegScale)}
            disabled={signalView !== 'eeg'}
          />
        </label>
        <div className="debug-link-summary">
          <span>{linkStatus}</span>
          <span>设备 flag <strong>{latestDeviceFlag ?? '--'}</strong></span>
          <span>算法服务 <strong>{demoPhase}</strong></span>
        </div>
      </div>

      <div className="debug-body">
        <section className="debug-waveforms" data-view={signalView} aria-label="EEGSleepUpper 调试波形">
          {signalView === 'eeg' ? EEG_CHANNELS.map((channel) => (
            <WaveformCanvas
              key={channel.key}
              title={`${channel.key.toUpperCase()} · ${debugEegFilterOptions.find((item) => item.value === filterMode)?.label}`}
              series={[{
                label: channel.key.toUpperCase(),
                color: channel.color,
                values: debugEeg[channel.key],
                scale: resolveDebugScale(eegScale)
              }]}
              fill
            />
          )) : (
            <>
              <WaveformCanvas
                title="PPG1 · IR / Red / Green"
                series={[
                  { label: 'IR1', color: '#8b5cf6', values: ppgBuffers.ir1.slice(-1000) },
                  { label: 'Red1', color: '#ef4444', values: ppgBuffers.red1.slice(-1000) },
                  { label: 'Green1', color: '#22c55e', values: ppgBuffers.green1.slice(-1000) }
                ]}
                fill
              />
              <WaveformCanvas
                title="PPG2 · IR / Red / Green"
                series={[
                  { label: 'IR2', color: '#a855f7', values: ppgBuffers.ir2.slice(-1000) },
                  { label: 'Red2', color: '#fb7185', values: ppgBuffers.red2.slice(-1000) },
                  { label: 'Green2', color: '#84cc16', values: ppgBuffers.green2.slice(-1000) }
                ]}
                fill
              />
            </>
          )}
        </section>

        <aside className="debug-inspector" aria-label="EEGSleepUpper 参数与控制">
          <DebugSection title="实时动作与连接" icon={<Gauge size={14} />}>
            <div className="debug-action-card">
              <span>锁存算法动作</span>
              <strong>{algorithmAction ?? '等待下一个动作'}</strong>
              <small>{demoMessage}</small>
            </div>
            <div className="debug-metric-grid is-compact">
              <DebugMetric label="信号质量" value={formatPercent(telemetry?.signal_quality)} />
              <DebugMetric label="算法通道" value={formatChannels(telemetry?.selected_alpha_channels)} />
              <DebugMetric label="通道权重" value={formatWeights(telemetry?.alpha_channel_weights)} />
              <DebugMetric label="通道切换" value={String(telemetry?.alpha_channel_switches ?? 0)} />
            </div>
          </DebugSection>

          <DebugSection title="Alpha 实时与个体双基线" icon={<Waves size={14} />}>
            <div className="debug-metric-grid">
              <DebugMetric label="Alpha 占比" value={formatPercent(telemetry?.alpha_ratio)} />
              <DebugMetric label="Alpha 强度" value={formatPercent(telemetry?.alpha_level)} />
              <DebugMetric label="开启阈值" value={formatPercent(telemetry?.alpha_on_threshold)} />
              <DebugMetric label="关闭阈值" value={formatPercent(telemetry?.alpha_off_threshold)} />
              <DebugMetric label="音量阶梯" value={telemetry ? `${telemetry.alpha_step}/${telemetry.alpha_step_count}` : '--'} />
              <DebugMetric label="推荐音量" value={formatPercent(telemetry?.recommended_volume)} />
            </div>
            <CalibrationLine
              label="睁眼基线"
              progress={state?.calibration_progress ?? 0}
              complete={state?.calibration_complete ?? false}
              detail={`初始 ${formatNumber(initialBaseline)} · 当前 ${formatNumber(currentBaseline)} · 变化 ${formatSignedPercent(baselineChange)} · 更新 ${telemetry?.adaptive_baseline_updates ?? 0} 次${guidanceActive ? ' · 会话内冻结' : ' · 缓慢自适应'}`}
              onStart={onOpenEyeCalibration}
            />
            <CalibrationLine
              label="闭眼 Alpha 基线"
              progress={state?.closed_eye_calibration_progress ?? 0}
              complete={state?.closed_eye_calibration_complete ?? false}
              detail={`参考强度 ${formatNumber(telemetry?.closed_eye_alpha_reference)}`}
              onStart={onClosedEyeCalibration}
            />
          </DebugSection>

          <DebugSection title="四通道配对眨眼诊断" icon={<Eye size={14} />}>
            <CalibrationLine
              label="3 秒安静 + 10 秒连续眨眼"
              progress={state?.blink_calibration_progress ?? 0}
              complete={state?.blink_calibration_complete ?? false}
              detail={blinkCalibrationDetail(demoResponse)}
              onStart={onBlinkCalibration}
            />
            <div className="debug-metric-grid">
              <DebugMetric label="待确认计数" value={String(state?.blink_count_pending ?? 0)} />
              <DebugMetric label="当前强度" value={`${formatNumber(telemetry?.blink_strength_z)} z`} />
              <DebugMetric label="当前宽度" value={formatMilliseconds(telemetry?.blink_width_seconds)} />
              <DebugMetric label="触发阈值" value={`${formatNumber(telemetry?.blink_threshold_robust_z)} z`} />
              <DebugMetric label="复位阈值" value={`${formatNumber(telemetry?.blink_rearm_robust_z)} z`} />
              <DebugMetric label="模板相关" value={formatNumber(telemetry?.blink_template_correlation)} />
              <DebugMetric label="有效配对" value={formatEnabledBlinkPairs(telemetry?.blink_enabled_channel_pairs)} />
              <DebugMetric label="隔离配对" value={disabledPairs} warning={disabledPairs !== '未启用'} />
            </div>
            <div className="debug-diagnostic-line">
              <span>单通道拒绝 <strong>{telemetry?.blink_single_channel_rejections ?? 0}</strong></span>
              <span>缺包拒绝 <strong>{telemetry?.blink_invalid_gap_rejections ?? 0}</strong></span>
              <span>模板拒绝 <strong>{telemetry?.blink_template_rejections ?? 0}</strong></span>
              <span>异常峰组 <strong>{telemetry?.blink_burst_rejections ?? 0}</strong></span>
              <span>组级命令 <strong>{telemetry?.blink_group_commands ?? 0}/{telemetry?.blink_group_evaluations ?? 0}</strong></span>
              <span>健康检查 <strong>{telemetry?.blink_baseline_health_checks ?? 0}</strong></span>
              <span>漂移重标 <strong>{telemetry?.blink_adaptive_baseline_updates ?? 0}</strong></span>
              <span>自动恢复 <strong>{telemetry?.blink_baseline_recoveries ?? 0}</strong></span>
            </div>
            <div className="debug-baseline-health" data-state={state?.blink_baseline_stale ? 'warning' : state?.blink_control_ready ? 'ready' : 'idle'}>
              <strong>{state?.blink_baseline_stale
                ? '基线漂移：控制暂停并快速恢复中'
                : state?.blink_control_ready
                  ? '眨眼模板与基线健康，控制就绪'
                  : '等待眨眼校准与稳定检查'}</strong>
              <span>{state?.blink_baseline_frozen ? '连续眨眼中冻结在线基线' : '组间自适应基线'} · 恢复进度 {formatPercent(telemetry?.blink_baseline_recovery_progress)}</span>
            </div>
          </DebugSection>

          <DebugSection title="保守睡眠判定" icon={<MoonStar size={14} />}>
            <div className="debug-metric-grid">
              <DebugMetric label="实时分期" value={stagingResponse?.model_stage_candidate ?? '--'} />
              <DebugMetric label="模型睡眠概率" value={formatPercent(stagingResponse?.model_sleep_probability)} />
              <DebugMetric label="控制分期" value={stagingResponse?.selected_stage ?? '--'} />
              <DebugMetric label="保守概率 / 阈值" value={`${formatPercent(stagingResponse?.selected_sleep_probability)} / 80%`} />
              <DebugMetric label="上下文" value={`${stagingResponse?.context_valid_count ?? 0}/8`} />
              <DebugMetric label="覆盖率" value={formatPercent(stagingResponse?.coverage)} />
              <DebugMetric label="最大缺口" value={`${formatNumber(stagingResponse?.maximum_contiguous_gap_seconds)} s`} />
              <DebugMetric label="推理耗时" value={`${formatNumber(stagingResponse?.runtime_step_ms, 1)} ms`} />
            </div>
            <div className="debug-sleep-state">
              <span>服务：{stagingPhase} · {stagingMessage}</span>
              <span>会话：{session.phase} · {session.reason}</span>
              <span>候选动作：{stagingResponse?.intervention_action_candidate ?? '--'} · 实际动作：{stagingResponse?.intervention_action ?? '--'}</span>
              <span>{stagingResponse?.autonomous_music_allowed ? '240 秒上下文就绪，允许自动控制' : '上下文未满，自动停止保持门控'}</span>
            </div>
          </DebugSection>

          <DebugSection title="独立功能与音乐控制" icon={<SlidersHorizontal size={14} />}>
            <div className="debug-switch-grid">
              <label><input type="checkbox" checked={sleepSettings.autoMode} onChange={(event) => onSleepSettingsChange({ autoMode: event.target.checked })} />自动音乐：Alpha 后播放</label>
              <label><input type="checkbox" checked={sleepSettings.alphaVolumeControlEnabled} onChange={(event) => onSleepSettingsChange({ alphaVolumeControlEnabled: event.target.checked })} />Alpha 强度调节音量</label>
              <label><input type="checkbox" checked={sleepSettings.blinkControlEnabled} onChange={(event) => onSleepSettingsChange({ blinkControlEnabled: event.target.checked })} />眨眼调节音量</label>
              <label><input type="checkbox" checked={sleepSettings.sleepStopEnabled} onChange={(event) => onSleepSettingsChange({ sleepStopEnabled: event.target.checked })} />入睡后关闭音乐</label>
            </div>
            <label className="debug-select-row">
              <span>Alpha 音量模式</span>
              <ThemedSelect
                ariaLabel="调试 Alpha 音量模式"
                value={sleepSettings.alphaVolumeMode}
                options={[
                  { value: '3', label: '3 阶梯' },
                  { value: '10', label: '10 阶梯' },
                  { value: '20', label: '20 阶梯' },
                  { value: 'smooth', label: '平滑' }
                ]}
                onChange={(value) => onSleepSettingsChange({ alphaVolumeMode: value as SleepMusicSettings['alphaVolumeMode'] })}
              />
            </label>
            <DebugRange
              label="当前音量"
              value={player.snapshot.volume}
              max={sleepSettings.maximumVolume}
              onChange={(value) => {
                player.setVolume(value);
                onSleepSettingsChange({ baseVolume: value });
              }}
            />
            <DebugRange
              label="最高音量阈值"
              value={sleepSettings.maximumVolume}
              max={1}
              min={0.05}
              onChange={(maximumVolume) => onSleepSettingsChange({
                maximumVolume,
                baseVolume: Math.min(sleepSettings.baseVolume, maximumVolume)
              })}
            />
            <div className="debug-music-row">
              <span><Volume2 size={13} />{player.selectedTrack?.name ?? '尚未选择音乐'}</span>
              <button type="button" onClick={() => void player.toggle()} disabled={!player.selectedTrack}>
                {player.snapshot.playing ? <Pause size={12} /> : <Play size={12} />}
                {player.snapshot.playing ? '暂停' : '播放'}
              </button>
              <button type="button" onClick={guidanceActive ? onStopGuidance : onStartGuidance}>
                {guidanceActive ? '结束助眠' : '开始助眠'}
              </button>
            </div>
            <label className="debug-select-row">
              <span>音频输出设备</span>
              <ThemedSelect
                ariaLabel="调试音频输出设备"
                value={player.snapshot.selectedOutputDeviceId}
                options={player.snapshot.outputDevices.map((device) => ({ value: device.deviceId, label: device.label }))}
                onChange={(deviceId) => {
                  void player.setOutputDevice(deviceId).then((changed) => {
                    if (changed) onSleepSettingsChange({ audioOutputDeviceId: deviceId });
                  });
                }}
              />
            </label>
            <div className="debug-music-row">
              <button type="button" onClick={() => void player.refreshOutputDevices(true)}>刷新音频设备</button>
              <button type="button" onClick={() => void player.testOutput()}>测试输出声音</button>
              {player.snapshot.outputDeviceError && <small>{player.snapshot.outputDeviceError}</small>}
            </div>
            <small className="debug-guidance-message">{guidanceMessage}</small>
          </DebugSection>

          <DebugSection title="记录会话与眨眼真值测试" icon={<ListChecks size={14} />}>
            <label className="debug-participant-id">
              <span>匿名受试者 ID</span>
              <input
                value={participantId}
                maxLength={32}
                placeholder="例如 P001；不要填写姓名或手机号"
                onChange={(event) => onParticipantIdChange(event.target.value)}
                disabled={recording}
              />
            </label>
            <div className="debug-session-actions">
              <button type="button" onClick={onStartSleepAndRecord}><Play size={12} />开始助眠并记录</button>
              <button type="button" onClick={onStartBlinkValidation}><Eye size={12} />仅眨眼验证并记录</button>
              <button type="button" onClick={onStopSession}><CircleStop size={12} />结束/停止记录</button>
            </div>
            <div className="debug-trial-buttons">
              <button type="button" disabled={!recording || blinkTrial?.status === 'active'} onClick={() => onStartBlinkTrial(0)}>标记 10 秒无指令</button>
              <button type="button" disabled={!recording || blinkTrial?.status === 'active'} onClick={() => onStartBlinkTrial(3)}>标记并测试 3 次</button>
              <button type="button" disabled={!recording || blinkTrial?.status === 'active'} onClick={() => onStartBlinkTrial(5)}>标记并测试 5 次</button>
            </div>
            {blinkTrial && (
              <div className="debug-trial-status" data-state={blinkTrial.status === 'active' ? 'active' : blinkTrial.success ? 'ready' : 'warning'}>
                <strong>{blinkTrial.status === 'active'
                  ? `真值窗进行中 · 剩余 ${(trialRemaining / 1000).toFixed(1)} 秒`
                  : `真值测试${blinkTrial.success ? '通过' : '未通过'}`}</strong>
                <span>预期 {blinkTrial.expectedCount === 0 ? '无连续指令' : `${blinkTrial.expectedCount} 次`} · {blinkTrial.detectedCount ? `检出 ${blinkTrial.detectedCount} 次` : '尚未检出命令'}</span>
              </div>
            )}
            <div className="debug-marker-buttons">
              {MARKERS.map((label) => (
                <button key={label} type="button" disabled={!recording} onClick={() => onAddMarker(label, note)}>
                  <Flag size={12} />{label}
                </button>
              ))}
            </div>
            <label className="debug-note">
              备注
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="动作速度、真假事件、佩戴或接触状态" />
            </label>
            <button type="button" className="debug-custom-marker" disabled={!recording || !note.trim()} onClick={() => onAddMarker('自定义标记', note)}>
              <Save size={13} />保存自定义标记
            </button>
            <div className="debug-paths">
              <span>数据文件<code>{recordPath || '--'}</code></span>
              <span>标记文件<code>{markerPath || '--'}</code></span>
              <small>{markerStatus}</small>
            </div>
          </DebugSection>

          <DebugSection title="算法事件日志" icon={<Flag size={14} />}>
            <div className="debug-event-log" aria-label="算法事件日志">
              {algorithmEvents.length === 0 && markers.length === 0 ? <span>等待算法事件或人工标记</span> : (
                <>
                  {algorithmEvents.slice(-20).reverse().map((event) => (
                    <div key={`${event.timestamp}-${event.label}-${event.detail}`}>
                      <time>{formatClock(event.timestamp)}</time><strong>{event.label}</strong><small>{event.detail}</small>
                    </div>
                  ))}
                  {markers.slice(-10).reverse().map((marker) => (
                    <div key={`${marker.timestamp}-${marker.sampleCount}-${marker.label}`} data-kind="marker">
                      <time>{formatClock(marker.timestamp)}</time><strong>{marker.label}</strong><small>sample {marker.sampleCount}{marker.note ? ` · ${marker.note}` : ''}</small>
                    </div>
                  ))}
                </>
              )}
            </div>
          </DebugSection>
        </aside>
      </div>
    </div>
  );
}

function DebugSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="debug-section panel">
      <header><span>{icon}</span><strong>{title}</strong></header>
      <div className="debug-section-body">{children}</div>
    </section>
  );
}

function DebugMetric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <span className="debug-metric" data-warning={warning}><small>{label}</small><strong>{value}</strong></span>;
}

function CalibrationLine({
  label,
  progress,
  complete,
  detail,
  onStart
}: {
  label: string;
  progress: number;
  complete: boolean;
  detail: string;
  onStart: () => void;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="debug-calibration-line" data-state={complete ? 'complete' : percent > 0 ? 'running' : 'idle'}>
      <div><strong>{label}</strong><span>{complete ? '已完成' : `${percent}%`}</span></div>
      <div className="debug-progress"><span style={{ width: `${percent}%` }} /></div>
      <small>{detail}</small>
      <button type="button" onClick={onStart}><RotateCcw size={11} />{complete ? '重新测量' : '开始测量'}</button>
    </div>
  );
}

function DebugRange({
  label,
  value,
  onChange,
  min = 0,
  max
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max: number;
}) {
  return (
    <label className="debug-range">
      <span>{label}<strong>{Math.round(value * 100)}%</strong></span>
      <input type="range" min={min} max={max} step={0.01} value={Math.min(value, max)} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function blinkCalibrationDetail(response: SleepDemoSignalResponse | null): string {
  if (!response) return '等待 PC 眨眼算法服务';
  const { state, telemetry } = response;
  if (state.blink_calibration_status === 'running') {
    const quietFraction = 3 / 13;
    return state.blink_calibration_progress < quietFraction
      ? '阶段 1/2：睁眼安静、头部不动、不要眨眼（3 秒）'
      : '阶段 2/2：每 0.5–1 秒自然眨眼一次（10 秒）';
  }
  if (state.blink_calibration_status === 'failed') {
    return `校准失败：${state.blink_calibration_failure_reason ?? '同步峰、一致率或强度不足'}`;
  }
  if (state.blink_calibration_complete) {
    return `参考阈值 ${formatReferenceStrength(telemetry.blink_threshold_robust_z, ' z') ?? '--'} · 校准峰 ${telemetry.blink_calibration_peak_count} · 一致率 ${formatPercent(telemetry.blink_calibration_consensus_fraction)} · 稳定等待 ${(state.blink_stabilization_remaining_seconds ?? 0).toFixed(1)} s`;
  }
  return '点击后先安静 3 秒，再连续自然眨眼 10 秒；完成后安静 5 秒检查漂移';
}

function formatPercent(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${Math.round(Number(value) * 100)}%` : '--';
}

function formatSignedPercent(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '--';
  const percent = Number(value) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function formatNumber(value: number | null | undefined, digits = 3): string {
  if (!Number.isFinite(value)) return '--';
  const numeric = Number(value);
  return Math.abs(numeric) >= 1000 ? numeric.toExponential(2) : numeric.toFixed(digits);
}

function formatMilliseconds(seconds: number | null | undefined): string {
  return Number.isFinite(seconds) ? `${Math.round(Number(seconds) * 1000)} ms` : '--';
}

function formatChannels(channels: number[] | undefined): string {
  return channels && channels.length > 0 ? channels.map((channel) => `EEG${channel}`).join(' + ') : '--';
}

function formatWeights(weights: number[] | undefined): string {
  return weights && weights.length > 0 ? weights.map((weight) => weight.toFixed(2)).join(' / ') : '--';
}

function formatClock(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString('zh-CN', { hour12: false });
}
