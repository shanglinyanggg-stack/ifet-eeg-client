import type React from 'react';
import {
  eegScaleOptions,
  eegTimeWindowOptions,
  themeOptions,
  type AppSettings,
  type EegBandKey,
  type EegChannel,
  type ThemeName
} from '../domain/settings';
import { createEegBands } from '../domain/dsp';
import {
  blinkCalibrationFailureMessage,
  formatEnabledBlinkPairs,
  formatSelectedAlphaChannels,
  type SleepDemoSignalResponse
} from '../domain/sleep-demo-signal';
import { channelLabels, type ChannelKey } from '../domain/protocol';
import type { BlinkGestureSnapshot } from '../domain/blink-gesture';
import { ThemedSelect } from './ThemedSelect';
import { ChevronRight, Eye, FolderOpen, ListMusic, Music2, Play, ServerCog, SlidersHorizontal, Square } from 'lucide-react';

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  sleepServiceStatus?: {
    phase: 'local' | 'checking' | 'warming' | 'ready' | 'fallback';
    message: string;
    chunksSeen: number;
  };
  sleepDemoStatus?: {
    phase: 'local' | 'calibrating' | 'ready' | 'fallback';
    message: string;
    lastResponse: SleepDemoSignalResponse | null;
  };
  sleepRuntime?: {
    algorithm_dir: string;
    venv_ready: boolean;
    service_running: boolean;
  } | null;
  blinkStatus?: BlinkGestureSnapshot;
  onOpenSleepAlgorithm?: () => void;
  onStartSleepService?: () => void;
  onStopSleepService?: () => void;
  onBlinkCalibration?: () => void;
  onOpenMusicLibrary?: () => void;
}

const channels = Object.keys(channelLabels) as ChannelKey[];
const displayModeOptions = [
  { value: 'normal', label: '全部波形' },
  { value: 'eeg', label: '脑电模式' }
];
const eegChannelOptions = [
  { value: 'eeg1', label: 'EEG1' },
  { value: 'eeg2', label: 'EEG2' },
  { value: 'eeg3', label: 'EEG3' },
  { value: 'eeg4', label: 'EEG4' }
];
const notchOptions = [
  { value: 'off', label: '关闭' },
  { value: '50', label: '50 Hz' },
  { value: '60', label: '60 Hz' }
];
const sleepDemoPhaseOptions = [
  { value: 'live', label: '跟随实时数据' },
  { value: 'ready', label: '等待放松' },
  { value: 'relaxing', label: '放松并播放' },
  { value: 'transition', label: '入睡并渐弱' },
  { value: 'light-sleep', label: '浅睡并停止' },
  { value: 'signal-poor', label: '信号质量不足' }
];
const alphaVolumeModeOptions = [
  { value: '3', label: '3 级平滑' },
  { value: '10', label: '10 级精细' },
  { value: '20', label: '20 级精细' },
  { value: 'smooth', label: '连续平滑' }
];

export function SettingsPanel({
  settings,
  onChange,
  sleepServiceStatus,
  sleepDemoStatus,
  sleepRuntime,
  blinkStatus,
  onOpenSleepAlgorithm,
  onStartSleepService,
  onStopSleepService,
  onBlinkCalibration,
  onOpenMusicLibrary
}: SettingsPanelProps) {
  const update = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });
  const updateEeg = (patch: Partial<AppSettings['eeg']>) =>
    onChange({ ...settings, eeg: { ...settings.eeg, ...patch } });
  const updateSleepMusic = (patch: Partial<AppSettings['sleepMusic']>) =>
    onChange({ ...settings, sleepMusic: { ...settings.sleepMusic, ...patch } });
  const blinkResponse = sleepDemoStatus?.lastResponse;
  const blinkCalibrationStatus = blinkResponse?.state.blink_calibration_status
    ?? blinkStatus?.calibrationStatus
    ?? 'idle';
  const blinkStale = blinkResponse?.state.blink_baseline_stale
    ?? blinkStatus?.baselineStale
    ?? false;
  const blinkFailure = blinkCalibrationFailureMessage(
    blinkResponse?.state.blink_calibration_failure_reason ?? blinkStatus?.calibrationFailureReason
  );

  return (
    <aside className="settings-panel" aria-label="后台设置">
      <div className="panel-header">
        <h2>后台设置</h2>
      </div>
      <div className="field-control">
        <span className="field-label">显示模式</span>
        <ThemedSelect
          ariaLabel="显示模式"
          value={settings.displayMode}
          options={displayModeOptions}
          onChange={(displayMode) => update({ displayMode: displayMode as AppSettings['displayMode'] })}
        />
      </div>
      <div className="field-control">
        <span className="field-label">界面主题</span>
        <ThemedSelect
          ariaLabel="界面主题"
          value={settings.theme}
          options={themeOptions}
          onChange={(theme) => update({ theme: theme as ThemeName })}
        />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.autoReconnect} onChange={(event) => update({ autoReconnect: event.target.checked })} />
        自动重连
      </label>
      <label className="check-row">
        <input type="checkbox" checked={settings.showChartsOnly} onChange={(event) => update({ showChartsOnly: event.target.checked })} />
        纯波形模式
      </label>
      <label className="check-row">
        <input type="checkbox" checked={settings.demoMode} onChange={(event) => update({ demoMode: event.target.checked })} />
        演示模式（模拟数据）
      </label>
      <label>
        预热秒数
        <input
          type="number"
          min={0}
          value={settings.warmupDelaySeconds}
          onChange={(event) => update({ warmupDelaySeconds: Number(event.target.value) })}
        />
      </label>
      <label>
        保存目录
        <div className="dir-row">
          <input value={settings.recordDir} onChange={(event) => update({ recordDir: event.target.value })} placeholder="留空使用默认目录" />
          <button
            type="button"
            className="icon-button"
            onClick={async () => {
              const picked = await pickDirectory();
              if (picked) update({ recordDir: picked });
            }}
            title="选择目录"
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </label>

      <div className="setting-group sleep-settings-group">
        <h3><span className="group-dot" /><Music2 size={14} />睡眠音乐引导</h3>
        <div className="sleep-setting-switches">
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.sleepMusic.enabled}
              onChange={(event) => updateSleepMusic({ enabled: event.target.checked })}
            />
            启用音乐引导
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.sleepMusic.autoMode}
              onChange={(event) => updateSleepMusic({ autoMode: event.target.checked })}
            />
            自动播放控制
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.sleepMusic.audienceCues}
              onChange={(event) => updateSleepMusic({ audienceCues: event.target.checked })}
            />
            大屏动作提示
          </label>
        </div>

        <button type="button" className="settings-open-library" onClick={onOpenMusicLibrary} disabled={!onOpenMusicLibrary}>
          <span className="settings-open-library-icon"><ListMusic size={16} /></span>
          <span>
            <strong>助眠歌单</strong>
            <small>{settings.sleepMusic.tracks.length > 0
              ? `${settings.sleepMusic.tracks.length} 首 · ${settings.sleepMusic.tracks.find((track) => track.id === settings.sleepMusic.selectedTrackId)?.name ?? '等待选择'}`
              : '尚未添加音乐'}</small>
          </span>
          <ChevronRight size={16} />
        </button>

        <RangeSetting
          label="播放音量"
          value={settings.sleepMusic.baseVolume}
          min={0}
          max={1}
          step={0.01}
          display={`${Math.round(settings.sleepMusic.baseVolume * 100)}%`}
          onChange={(baseVolume) => updateSleepMusic({ baseVolume })}
        />
        <RangeSetting
          label="渐弱目标"
          value={settings.sleepMusic.transitionVolume}
          min={0}
          max={0.6}
          step={0.01}
          display={`${Math.round(settings.sleepMusic.transitionVolume * 100)}%`}
          onChange={(transitionVolume) => updateSleepMusic({ transitionVolume })}
        />
        <RangeSetting
          label="停止淡出"
          value={settings.sleepMusic.stopFadeSeconds}
          min={0}
          max={30}
          step={1}
          display={`${settings.sleepMusic.stopFadeSeconds}s`}
          onChange={(stopFadeSeconds) => updateSleepMusic({ stopFadeSeconds })}
        />

        {settings.demoMode && (
          <div className="field-control sleep-demo-phase">
            <span className="field-label">演示阶段</span>
            <ThemedSelect
              ariaLabel="演示阶段"
              value={settings.sleepMusic.demoPhase}
              options={sleepDemoPhaseOptions}
              onChange={(demoPhase) => updateSleepMusic({
                demoPhase: demoPhase as AppSettings['sleepMusic']['demoPhase']
              })}
            />
          </div>
        )}

        <details className="setting-disclosure">
          <summary><SlidersHorizontal size={14} />判定与交互参数</summary>
          <div className="setting-disclosure-body">
            {sleepServiceStatus && (
              <div className="sleep-service-status" data-state={sleepServiceStatus.phase} role="status">
                <i />
                <strong>{sleepServiceStatus.message}</strong>
                <span>{sleepServiceStatus.chunksSeen * 5}s</span>
              </div>
            )}
            {sleepDemoStatus && sleepDemoStatus.phase !== 'local' && (
              <div className="sleep-service-status is-demo" data-state={sleepDemoStatus.phase} role="status">
                <i />
                <strong>{sleepDemoStatus.message}</strong>
                <span>{formatSelectedAlphaChannels(sleepDemoStatus.lastResponse)}</span>
              </div>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.sleepMusic.blinkControlEnabled}
                onChange={(event) => updateSleepMusic({ blinkControlEnabled: event.target.checked })}
              />
              <Eye size={13} />眨眼音量控制
            </label>
            <div className="field-control">
              <span className="field-label">Alpha 音量模式</span>
              <ThemedSelect
                ariaLabel="Alpha 音量模式"
                value={settings.sleepMusic.alphaVolumeMode}
                options={alphaVolumeModeOptions}
                onChange={(alphaVolumeMode) => updateSleepMusic({
                  alphaVolumeMode: alphaVolumeMode as AppSettings['sleepMusic']['alphaVolumeMode']
                })}
              />
            </div>
            <div className="blink-calibration-settings" data-state={blinkStale ? 'stale' : blinkCalibrationStatus}>
              <div>
                <strong>EEG1-EEG4 双配对个体测量</strong>
                <span>{blinkStale
                  ? '基线漂移超限，控制已暂停，请重新测量'
                  : blinkCalibrationStatus === 'complete'
                  ? `已启用 ${formatEnabledBlinkPairs(blinkResponse?.telemetry.blink_enabled_channel_pairs ?? blinkStatus?.enabledPairs)}`
                  : blinkCalibrationStatus === 'running'
                    ? `测量中 ${Math.round((blinkResponse?.state.blink_calibration_progress ?? blinkStatus?.calibrationProgress ?? 0) * 100)}%`
                    : blinkCalibrationStatus === 'failed'
                      ? blinkFailure
                      : '先 3 秒睁眼安静不眨眼，再自然眨眼 10 秒'}</span>
              </div>
              <button type="button" onClick={onBlinkCalibration} disabled={!onBlinkCalibration}>
                <Eye size={13} />{blinkCalibrationStatus === 'complete' && !blinkStale ? '重新测量' : '开始测量'}
              </button>
              {(blinkResponse || blinkStatus) && (
                <dl>
                  <div><dt>配对有效峰</dt><dd>{blinkResponse?.telemetry.blink_calibration_peak_count ?? blinkStatus?.calibrationPeakCount ?? 0}</dd></div>
                  <div><dt>配对一致率</dt><dd>{Math.round((blinkResponse?.telemetry.blink_calibration_consensus_fraction ?? blinkStatus?.calibrationConsensus ?? 0) * 100)}%</dd></div>
                  <div><dt>单通道拒绝</dt><dd>{blinkResponse?.telemetry.blink_single_channel_rejections ?? blinkStatus?.singleChannelRejections ?? 0}</dd></div>
                  <div><dt>丢包拒绝</dt><dd>{blinkResponse?.telemetry.blink_invalid_gap_rejections ?? blinkStatus?.invalidGapRejections ?? 0}</dd></div>
                  <div><dt>节律补偿</dt><dd>{blinkResponse?.telemetry.blink_gap_recoveries ?? blinkStatus?.gapRecoveries ?? 0}</dd></div>
                  <div><dt>健康检查</dt><dd>{blinkResponse?.telemetry.blink_baseline_health_checks ?? blinkStatus?.baselineHealthChecks ?? 0}</dd></div>
                </dl>
              )}
            </div>
            <RangeSetting
              label="眨眼调节步长"
              value={settings.sleepMusic.blinkVolumeStep}
              min={0.05}
              max={0.3}
              step={0.05}
              display={`${Math.round(settings.sleepMusic.blinkVolumeStep * 100)}%`}
              onChange={(blinkVolumeStep) => updateSleepMusic({ blinkVolumeStep })}
            />
            <div className="two-col">
              <label>
                Alpha 放松阈值
                <input
                  type="number"
                  min={0.05}
                  max={0.9}
                  step={0.01}
                  value={settings.sleepMusic.relaxAlphaThreshold}
                  onChange={(event) => updateSleepMusic({ relaxAlphaThreshold: Number(event.target.value) })}
                />
              </label>
              <label>
                困意渐弱阈值
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={settings.sleepMusic.fadeSleepScoreThreshold}
                  onChange={(event) => updateSleepMusic({ fadeSleepScoreThreshold: Number(event.target.value) })}
                />
              </label>
              <label>
                困意停止阈值
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={settings.sleepMusic.stopSleepScoreThreshold}
                  onChange={(event) => updateSleepMusic({ stopSleepScoreThreshold: Number(event.target.value) })}
                />
              </label>
              <label>
                最低信号覆盖率
                <input
                  type="number"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={settings.sleepMusic.minimumCoverage}
                  onChange={(event) => updateSleepMusic({ minimumCoverage: Number(event.target.value) })}
                />
              </label>
            </div>
            <div className="two-col">
              <label>
                放松确认 s
                <input type="number" min={0} max={30} step={1} value={settings.sleepMusic.relaxConfirmSeconds} onChange={(event) => updateSleepMusic({ relaxConfirmSeconds: Number(event.target.value) })} />
              </label>
              <label>
                渐弱确认 s
                <input type="number" min={0} max={30} step={1} value={settings.sleepMusic.transitionConfirmSeconds} onChange={(event) => updateSleepMusic({ transitionConfirmSeconds: Number(event.target.value) })} />
              </label>
              <label>
                浅睡确认 s
                <input type="number" min={0} max={30} step={1} value={settings.sleepMusic.sleepConfirmSeconds} onChange={(event) => updateSleepMusic({ sleepConfirmSeconds: Number(event.target.value) })} />
              </label>
              <label>
                清醒恢复 s
                <input type="number" min={0} max={30} step={1} value={settings.sleepMusic.awakeConfirmSeconds} onChange={(event) => updateSleepMusic({ awakeConfirmSeconds: Number(event.target.value) })} />
              </label>
            </div>
            <RangeSetting
              label="平滑系数 EMA"
              value={settings.sleepMusic.emaAlpha}
              min={0.05}
              max={1}
              step={0.05}
              display={settings.sleepMusic.emaAlpha.toFixed(2)}
              onChange={(emaAlpha) => updateSleepMusic({ emaAlpha })}
            />
          </div>
        </details>

        <details className="setting-disclosure">
          <summary><ServerCog size={14} />PC 睡眠算法服务</summary>
          <div className="setting-disclosure-body">
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.sleepMusic.serviceEnabled}
                onChange={(event) => updateSleepMusic({ serviceEnabled: event.target.checked })}
              />
              启用 PC v1.2 算法
            </label>
            <label>
              服务地址
              <input
                value={settings.sleepMusic.serviceEndpoint}
                onChange={(event) => updateSleepMusic({ serviceEndpoint: event.target.value })}
                placeholder="http://127.0.0.1:8765"
              />
            </label>
            <div className="sleep-service-actions">
              <button type="button" onClick={onOpenSleepAlgorithm} disabled={!onOpenSleepAlgorithm}>
                <FolderOpen size={14} />算法目录
              </button>
              {sleepRuntime?.service_running ? (
                <button type="button" onClick={onStopSleepService} disabled={!onStopSleepService}>
                  <Square size={13} />停止服务
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStartSleepService}
                  disabled={!onStartSleepService || !sleepRuntime?.venv_ready}
                  title={sleepRuntime?.venv_ready ? '启动本地睡眠算法服务' : '算法环境尚未安装'}
                >
                  <Play size={14} />启动服务
                </button>
              )}
            </div>
            {sleepRuntime && (
              <div className="sleep-runtime-state" title={sleepRuntime.algorithm_dir}>
                <span>{sleepRuntime.venv_ready ? '算法环境就绪' : '算法环境未安装'}</span>
                <strong>{sleepRuntime.service_running ? '运行中' : '未运行'}</strong>
              </div>
            )}
          </div>
        </details>
      </div>

      <div className="setting-group">
        <h3><span className="group-dot" />原始滤波</h3>
        <label className="check-row">
          <input type="checkbox" checked={settings.filterEnabled} onChange={(event) => update({ filterEnabled: event.target.checked })} />
          带通滤波
        </label>
        <div className="two-col">
          <label>
            低频 Hz
            <input type="number" step="0.1" value={settings.filterLow} onChange={(event) => update({ filterLow: Number(event.target.value) })} />
          </label>
          <label>
            高频 Hz
            <input type="number" step="0.1" value={settings.filterHigh} onChange={(event) => update({ filterHigh: Number(event.target.value) })} />
          </label>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={settings.kalmanEnabled} onChange={(event) => update({ kalmanEnabled: event.target.checked })} />
          卡尔曼滤波
        </label>
        <div className="two-col">
          <label>
            Q
            <input type="number" step="0.01" value={settings.kalmanQ} onChange={(event) => update({ kalmanQ: Number(event.target.value) })} />
          </label>
          <label>
            R
            <input type="number" step="0.1" value={settings.kalmanR} onChange={(event) => update({ kalmanR: Number(event.target.value) })} />
          </label>
        </div>
      </div>

      <div className="setting-group">
        <h3><span className="group-dot" />脑电参数</h3>
        <div className="field-control">
          <span className="field-label">EEG 通道</span>
          <ThemedSelect
            ariaLabel="EEG 通道"
            value={settings.eeg.selectedChannel}
            options={eegChannelOptions}
            onChange={(selectedChannel) => updateEeg({ selectedChannel: selectedChannel as EegChannel })}
          />
        </div>
        <div className="two-col">
          <div className="field-control">
            <span className="field-label">Scale</span>
            <ThemedSelect
              ariaLabel="Scale"
              value={String(settings.eeg.scale)}
              options={eegScaleOptions}
              onChange={(scale) => updateEeg({ scale: parseAutoNumber(scale) })}
            />
          </div>
          <div className="field-control">
            <span className="field-label">时间窗 s</span>
            <ThemedSelect
              ariaLabel="时间窗"
              value={String(settings.eeg.timeWindowSeconds)}
              options={eegTimeWindowOptions}
              onChange={(timeWindowSeconds) => updateEeg({ timeWindowSeconds: parseAutoNumber(timeWindowSeconds) })}
            />
          </div>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={settings.eeg.bandpassEnabled} onChange={(event) => updateEeg({ bandpassEnabled: event.target.checked })} />
          EEG 带通
        </label>
        <div className="two-col">
          <label>
            EEG 低频
            <input type="number" step="0.1" value={settings.eeg.bandpassLow} onChange={(event) => updateEeg({ bandpassLow: Number(event.target.value) })} />
          </label>
          <label>
            EEG 高频
            <input type="number" step="0.1" value={settings.eeg.bandpassHigh} onChange={(event) => updateEeg({ bandpassHigh: Number(event.target.value) })} />
          </label>
        </div>
        <div className="field-control">
          <span className="field-label">陷波</span>
          <ThemedSelect
            ariaLabel="陷波"
            value={String(settings.eeg.notch)}
            options={notchOptions}
            onChange={(notch) => updateEeg({ notch: parseNotch(notch) })}
          />
        </div>
        <div className="band-editor">
          {createEegBands().map((band) => (
            <div className="band-row" key={band.key} style={{ '--band-color': band.color } as React.CSSProperties}>
              <span>{band.label}</span>
              <input
                type="number"
                step="0.1"
                value={settings.eeg.bandRanges[band.key].low}
                onChange={(event) => updateBand(settings, onChange, band.key, 'low', Number(event.target.value))}
              />
              <input
                type="number"
                step="0.1"
                value={settings.eeg.bandRanges[band.key].high}
                onChange={(event) => updateBand(settings, onChange, band.key, 'high', Number(event.target.value))}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="setting-group">
        <h3><span className="group-dot" />通道显示</h3>
        <div className="channel-grid">
          {channels.map((channel) => (
            <label className="check-row" key={channel}>
              <input
                type="checkbox"
                checked={settings.visibleChannels[channel] ?? true}
                onChange={(event) =>
                  update({
                    visibleChannels: {
                      ...settings.visibleChannels,
                      [channel]: event.target.checked
                    }
                  })
                }
              />
              {channelLabels[channel]}
            </label>
          ))}
        </div>
      </div>
    </aside>
  );
}

function RangeSetting({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-setting">
      <span><span>{label}</span><strong>{display}</strong></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function parseAutoNumber(value: string) {
  if (value.trim().toLowerCase() === 'auto') return 'auto';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'auto';
}

async function pickDirectory(): Promise<string | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false });
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

function parseNotch(value: string): AppSettings['eeg']['notch'] {
  if (value === '50') return 50;
  if (value === '60') return 60;
  return 'off';
}

function updateBand(
  settings: AppSettings,
  onChange: (settings: AppSettings) => void,
  band: EegBandKey,
  side: 'low' | 'high',
  value: number
) {
  onChange({
    ...settings,
    eeg: {
      ...settings.eeg,
      bandRanges: {
        ...settings.eeg.bandRanges,
        [band]: {
          ...settings.eeg.bandRanges[band],
          [side]: value
        }
      }
    }
  });
}
