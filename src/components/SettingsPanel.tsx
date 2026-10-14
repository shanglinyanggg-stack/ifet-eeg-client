import { useEffect, useState, type ReactNode } from 'react';
import type React from 'react';
import {
  displayDelayOptions,
  eegScaleOptions,
  eegTimeWindowOptions,
  themeOptions,
  type AppSettings,
  type EegBandKey,
  type EegChannel,
  type ThemeName
} from '../domain/settings';
import { createEegBands,createPureBands } from '../domain/dsp';
import {
  blinkCalibrationFailureMessage,
  calibrationProgress,
  formatEnabledBlinkPairs,
  formatReferenceStrength,
  formatSelectedAlphaChannels,
  type SleepDemoSignalResponse
} from '../domain/sleep-demo-signal';
import { channelLabels, type ChannelKey } from '../domain/protocol';
import type { BlinkGestureSnapshot } from '../domain/blink-gesture';
import type { LslStatus } from '../domain/lsl';
import type { SleepStagingRuntimeInfo } from '../domain/sleep-staging-client';
import { ThemedSelect } from './ThemedSelect';
import { LslSettingsSection } from './LslSettingsSection';
import { MatlabBridgeSection } from './MatlabBridgeSection';
import {SignalCalibrationSettings} from './SignalCalibrationSettings';
import { ChevronRight, Database, Eye, FolderOpen, ListMusic, Music2, PackagePlus, Play, RotateCcw, Send, ServerCog, SlidersHorizontal, Speaker, Square } from 'lucide-react';

interface SettingsPanelProps {
  requestedSection?:'general'|'signal'|'sleep'|'device'|'lsl'|'matlab';
  onSectionChange?:(section:'general'|'signal'|'sleep'|'device'|'lsl'|'matlab')=>void;
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
    alphaCalibrationSeconds: number;
    closedEyeCalibrationSeconds: number;
    blinkCalibrationSeconds: number;
    lastResponse: SleepDemoSignalResponse | null;
  };
  sleepRuntime?: SleepStagingRuntimeInfo | null;
  blinkStatus?: BlinkGestureSnapshot;
  onOpenSleepAlgorithm?: () => void;
  onImportSleepAlgorithm?: () => void;
  onActivateSleepAlgorithm?: (packageId: string, version: string) => void;
  onRollbackSleepAlgorithm?: () => void;
  onStartSleepService?: () => void;
  onStopSleepService?: () => void;
  onOpenEyeCalibration?: () => void;
  onClosedEyeCalibration?: () => void;
  onBlinkCalibration?: () => void;
  audioOutput?: {
    devices: Array<{ deviceId: string; label: string }>;
    selectedDeviceId: string;
    supported: boolean;
    error: string | null;
  };
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  onRefreshAudioOutputs?: () => void;
  onTestAudioOutput?: () => void;
  onOpenMusicLibrary?: () => void;
  connected?: boolean;
  commandText?: string;
  onCommandTextChange?: (value: string) => void;
  onSendCommand?: () => void;
  lslStatus?: LslStatus;
  lslPending?: boolean;
  onLslRefresh?: () => void;
  onLslTestMarker?: () => void;
}

const channels = Object.keys(channelLabels) as ChannelKey[];
const displayModeOptions = [
  { value: 'eeg', label: '脑电模式' },
  { value: 'debug', label: '调试模式' },
  { value: 'normal', label: '全部波形' }
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
  requestedSection,
  onSectionChange,
  settings,
  onChange,
  sleepServiceStatus,
  sleepDemoStatus,
  sleepRuntime,
  blinkStatus,
  onOpenSleepAlgorithm,
  onImportSleepAlgorithm,
  onActivateSleepAlgorithm,
  onRollbackSleepAlgorithm,
  onStartSleepService,
  onStopSleepService,
  onOpenEyeCalibration,
  onClosedEyeCalibration,
  onBlinkCalibration,
  audioOutput,
  onAudioOutputDeviceChange,
  onRefreshAudioOutputs,
  onTestAudioOutput,
  onOpenMusicLibrary,
  connected = false,
  commandText = 'AA 55 01 01',
  onCommandTextChange,
  onSendCommand,
  lslStatus,
  lslPending = false,
  onLslRefresh,
  onLslTestMarker
}: SettingsPanelProps) {
  const [section, setSectionState] = useState<'general' | 'signal' | 'sleep' | 'device' | 'lsl' | 'matlab'>('general');
  const setSection=(value:typeof section)=>{setSectionState(value);onSectionChange?.(value);};
  useEffect(()=>{if(requestedSection)setSectionState(requestedSection);},[requestedSection]);
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
  const openEyeComplete = blinkResponse?.state.calibration_complete ?? false;
  const closedEyeComplete = blinkResponse?.state.closed_eye_calibration_complete ?? false;
  const openEyeProgress = calibrationProgress(
    blinkResponse ?? null,
    sleepDemoStatus?.alphaCalibrationSeconds ?? 20,
    openEyeComplete,
    blinkResponse?.state.calibration_progress
  );
  const closedEyeProgress = calibrationProgress(
    blinkResponse ?? null,
    sleepDemoStatus?.closedEyeCalibrationSeconds ?? 20,
    closedEyeComplete,
    blinkResponse?.state.closed_eye_calibration_progress
  );
  const blinkProgress = calibrationProgress(
    blinkResponse ?? null,
    sleepDemoStatus?.blinkCalibrationSeconds ?? 10,
    blinkCalibrationStatus === 'complete',
    blinkResponse?.state.blink_calibration_progress ?? blinkStatus?.calibrationProgress
  );

  useEffect(() => {
    if (settings.acquisitionMode && section === 'sleep') setSection('general');
  }, [section, settings.acquisitionMode]);

  return (
    <aside className="settings-panel" aria-label="后台设置">
      <div className="panel-header">
        <h2>后台设置</h2>
      </div>
      <nav className="settings-tabs" aria-label="设置分类">
        <SettingsTab active={section === 'general'} onClick={() => setSection('general')}>常规</SettingsTab>
        <SettingsTab active={section === 'signal'} onClick={() => setSection('signal')}>信号</SettingsTab>
        <SettingsTab active={section === 'sleep'} disabled={settings.acquisitionMode} onClick={() => setSection('sleep')}>助眠</SettingsTab>
        <SettingsTab active={section === 'device'} onClick={() => setSection('device')}>设备</SettingsTab>
        <SettingsTab active={section === 'lsl'} onClick={() => setSection('lsl')}>LSL</SettingsTab>
        <SettingsTab active={section === 'matlab'} onClick={() => setSection('matlab')}>MATLAB</SettingsTab>
      </nav>
      {section === 'matlab' && <MatlabBridgeSection onPrepare={() => update({ acquisitionMode: true, showChartsOnly: false, demoMode: false })} />}
      {settings.acquisitionMode && (
        <div className="acquisition-settings-notice">
          <Database size={15} />
          <span><strong>数据采集模式运行中</strong><small>音乐、基线、分期与眨眼控制均不会运行。</small></span>
        </div>
      )}
      {section === 'general' && <>
      <label className="check-row acquisition-mode-setting">
        <input
          type="checkbox"
          checked={settings.acquisitionMode}
          onChange={(event) => update({
            acquisitionMode: event.target.checked,
            showChartsOnly: event.target.checked ? false : settings.showChartsOnly
          })}
        />
        <Database size={14} />数据采集模式
      </label>
      <div className="field-control">
        <span className="field-label">显示模式</span>
        <ThemedSelect
          ariaLabel="显示模式"
          value={settings.displayMode}
          options={displayModeOptions}
          onChange={(displayMode) => update({ displayMode: displayMode as AppSettings['displayMode'] })}
          disabled={settings.acquisitionMode}
        />
      </div>
      <small className="setting-help">资源策略：只绘制选中页面；隐藏分析标签页暂停频谱/频带计算。非数采模式下，已启用的分期、Alpha/眨眼服务作为共享任务继续运行，切换页面不会停止记录、LSL或MATLAB收标。数据采集模式会停用这些助眠算法。</small>
      <div className="field-control">
        <span className="field-label">界面主题</span>
        <ThemedSelect
          ariaLabel="界面主题"
          value={settings.theme}
          options={themeOptions}
          onChange={(theme) => update({ theme: theme as ThemeName })}
        />
      </div>
      <div className="field-control">
        <span className="field-label">信号显示时延</span>
        <ThemedSelect
          ariaLabel="信号显示时延"
          value={String(settings.displayDelayMs)}
          options={displayDelayOptions}
          onChange={(displayDelayMs) => update({ displayDelayMs: Number(displayDelayMs) })}
        />
        <small className="setting-help">实时切换可视时间锚点，不改变采集、保存或算法输入。</small>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.signalDisplay.interpolateGaps}
          onChange={event=>update({signalDisplay:{...settings.signalDisplay,interpolateGaps:event.target.checked}})} />
        信号短断点自动插值（仅显示）
      </label>
      <small className="setting-help">仅连接两端均有效且不超过100毫秒的断点，以虚线显示。默认关闭；不改变原始记录、LSL、频谱算法或丢包率，长断开保持空白。</small>
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
      </>}

      {section === 'sleep' && !settings.acquisitionMode && <>
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
            自动音乐：检测 Alpha 后播放
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.sleepMusic.alphaVolumeControlEnabled}
              onChange={(event) => updateSleepMusic({ alphaVolumeControlEnabled: event.target.checked })}
            />
            Alpha 强度调节音量
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.sleepMusic.sleepStopEnabled}
              onChange={(event) => updateSleepMusic({ sleepStopEnabled: event.target.checked })}
            />
            在线检测入睡后关闭音乐
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

        <div className="audio-output-setting">
          <div>
            <span className="field-label"><Speaker size={13} />音频播放设备</span>
            <ThemedSelect
              ariaLabel="音频播放设备"
              value={audioOutput?.selectedDeviceId ?? settings.sleepMusic.audioOutputDeviceId}
              options={(audioOutput?.devices ?? [{ deviceId: 'default', label: '系统默认输出' }]).map((device) => ({
                value: device.deviceId,
                label: device.label
              }))}
              onChange={(deviceId) => onAudioOutputDeviceChange?.(deviceId)}
            />
            <button type="button" onClick={onRefreshAudioOutputs} disabled={!onRefreshAudioOutputs}>
              授权刷新
            </button>
            <button type="button" onClick={onTestAudioOutput} disabled={!onTestAudioOutput}>
              测试声音
            </button>
          </div>
          <small>{audioOutput?.error ?? (audioOutput?.supported
            ? '音乐只切换输出设备；设备授权不会录制音频'
            : '未支持设备选择时自动使用系统默认输出')}</small>
        </div>

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
          label="最高音量阈值"
          value={settings.sleepMusic.maximumVolume}
          min={0.05}
          max={1}
          step={0.01}
          display={`${Math.round(settings.sleepMusic.maximumVolume * 100)}%`}
          onChange={(maximumVolume) => updateSleepMusic({
            maximumVolume,
            baseVolume: Math.min(settings.sleepMusic.baseVolume, maximumVolume)
          })}
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
            <p className="algorithm-consistency-note">
              Alpha音乐交互保持原有个体睁闭眼校准算法。新版困意指数需单独测量20秒睁眼清醒基线，参考EEG1和EEG2的Theta/Beta与Theta/Alpha持续变化；基线冻结，伪迹期间暂停，Alpha单独增强不判困倦。指数为个人相对变化，不是睡眠概率或医学诊断；可切换0.2.5作为历史对照。数据采集模式不运行困意、基线或音乐控制。
            </p>
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
            <div className="baseline-calibration-grid">
              <BaselineCalibrationCard
                title="睁眼基线"
                instruction={openEyeComplete
                  ? '已建立个体睁眼 Alpha 参考；需要更换佩戴位置时可重新测量'
                  : '平视前方，面部放松，尽量少眨眼，保持头部不动'}
                progress={openEyeProgress}
                complete={openEyeComplete}
                running={Boolean(blinkResponse) && !openEyeComplete}
                reference={formatReferenceStrength(blinkResponse?.telemetry.open_eye_alpha_baseline)}
                progressHint={openEyeComplete ? '测量完成' : '睁眼平视，保持静止'}
                duration={`${sleepDemoStatus?.alphaCalibrationSeconds ?? 20}s`}
                onStart={onOpenEyeCalibration}
              />
              <BaselineCalibrationCard
                title="闭眼基线"
                instruction={closedEyeComplete
                  ? '已建立闭眼 Alpha 强度参考'
                  : openEyeComplete
                    ? '自然闭眼，保持清醒和静止，不要咬牙或转头'
                    : '请先完成睁眼基线'}
                progress={closedEyeProgress}
                complete={closedEyeComplete}
                running={openEyeComplete && !closedEyeComplete && closedEyeProgress > 0}
                reference={formatReferenceStrength(blinkResponse?.telemetry.closed_eye_alpha_reference)}
                progressHint={closedEyeComplete
                  ? '测量完成'
                  : openEyeComplete
                    ? '自然闭眼，保持清醒'
                    : '请先完成睁眼基线'}
                duration={`${sleepDemoStatus?.closedEyeCalibrationSeconds ?? 20}s`}
                onStart={onClosedEyeCalibration}
                disabled={!openEyeComplete}
              />
              <BaselineCalibrationCard
                title="眨眼基线"
                instruction={blinkStale
                  ? `漂移恢复中 ${Math.round((blinkResponse?.telemetry.blink_baseline_recovery_progress ?? blinkStatus?.baselineRecoveryProgress ?? 0) * 100)}%，恢复后自动重开控制`
                  : blinkCalibrationStatus === 'complete'
                    ? `已启用 ${formatEnabledBlinkPairs(blinkResponse?.telemetry.blink_enabled_channel_pairs ?? blinkStatus?.enabledPairs)}`
                    : blinkCalibrationStatus === 'running'
                      ? blinkProgress < 3 / 13
                        ? '保持睁眼安静，前 3 秒不要眨眼'
                        : '连续自然眨眼，每 0.5–1 秒一次；保持头和下颌不动'
                      : blinkCalibrationStatus === 'failed'
                        ? blinkFailure
                        : '先 3 秒睁眼安静，再连续自然眨眼 10 秒'}
                progress={blinkProgress}
                complete={blinkCalibrationStatus === 'complete' && !blinkStale}
                running={blinkCalibrationStatus === 'running' || blinkStale}
                reference={formatReferenceStrength(blinkResponse?.telemetry.blink_threshold_robust_z, ' z')}
                progressHint={blinkStale
                  ? '基线漂移恢复中'
                  : blinkCalibrationStatus === 'complete'
                    ? '测量完成'
                    : blinkCalibrationStatus === 'running'
                      ? blinkProgress < 3 / 13
                        ? '保持睁眼，暂不眨眼'
                        : '连续自然眨眼 · 0.5–1 秒/次'
                      : '准备：先静止 3 秒'}
                duration="3+10s"
                onStart={onBlinkCalibration}
              />
            </div>
            <div className="blink-calibration-settings" data-state={blinkStale ? 'stale' : blinkCalibrationStatus}>
              {(blinkResponse || blinkStatus) && (
                <dl>
                  <div><dt>配对有效峰</dt><dd>{blinkResponse?.telemetry.blink_calibration_peak_count ?? blinkStatus?.calibrationPeakCount ?? 0}</dd></div>
                  <div><dt>配对一致率</dt><dd>{Math.round((blinkResponse?.telemetry.blink_calibration_consensus_fraction ?? blinkStatus?.calibrationConsensus ?? 0) * 100)}%</dd></div>
                  <div><dt>单通道拒绝</dt><dd>{blinkResponse?.telemetry.blink_single_channel_rejections ?? blinkStatus?.singleChannelRejections ?? 0}</dd></div>
                  <div><dt>丢包拒绝</dt><dd>{blinkResponse?.telemetry.blink_invalid_gap_rejections ?? blinkStatus?.invalidGapRejections ?? 0}</dd></div>
                  <div><dt>节律补偿</dt><dd>{blinkResponse?.telemetry.blink_gap_recoveries ?? blinkStatus?.gapRecoveries ?? 0}</dd></div>
                  <div><dt>健康检查</dt><dd>{blinkResponse?.telemetry.blink_baseline_health_checks ?? blinkStatus?.baselineHealthChecks ?? 0}</dd></div>
                  <div><dt>自动恢复</dt><dd>{blinkResponse?.telemetry.blink_baseline_recoveries ?? blinkStatus?.baselineRecoveries ?? 0}</dd></div>
                  <div><dt>暂停配对</dt><dd>{formatEnabledBlinkPairs(blinkResponse?.telemetry.blink_runtime_disabled_pairs ?? blinkStatus?.runtimeDisabledPairs)}</dd></div>
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
            <label>
              困意值算法
              <ThemedSelect
                ariaLabel="困意值算法"
                value={settings.sleepMusic.drowsinessMode}
                options={[
                  { value: 'personal-baseline', label: '个人清醒基线指数（新版）' },
                  { value: 'v025', label: '0.2.5 对照算法' }
                ]}
                onChange={(drowsinessMode) => updateSleepMusic({
                  drowsinessMode: drowsinessMode as AppSettings['sleepMusic']['drowsinessMode']
                })}
              />
              <small>试验模式先采集 60 秒高质量清醒基线，再融合频带比值与 PC 睡眠概率；低质量窗口保持上一结果。</small>
            </label>
            <div className="two-col">
              <label>
                本地降级 Alpha 阈值
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
                placeholder="http://127.0.0.1:8787"
              />
            </label>
            <div className="sleep-service-actions">
              <button type="button" onClick={onOpenSleepAlgorithm} disabled={!onOpenSleepAlgorithm}>
                <FolderOpen size={14} />算法目录
              </button>
              <button type="button" onClick={onImportSleepAlgorithm} disabled={!onImportSleepAlgorithm || sleepRuntime?.service_running}>
                <PackagePlus size={14} />安装算法包
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
              <>
                <div className="sleep-runtime-state" title={sleepRuntime.algorithm_dir}>
                  <span>{sleepRuntime.active_package.display_name}</span>
                  <strong>{sleepRuntime.service_running ? '运行中' : '未运行'}</strong>
                </div>
                <div className="algorithm-package-list" role="list" aria-label="已安装算法包">
                  {sleepRuntime.available_packages.map((algorithmPackage) => (
                    <div
                      className="algorithm-package-item"
                      data-active={algorithmPackage.active}
                      data-channel={algorithmPackage.channel}
                      key={`${algorithmPackage.package_id}@${algorithmPackage.version}`}
                      role="listitem"
                    >
                      <span>
                        <strong>{algorithmPackage.display_name}</strong>
                        <small>{algorithmPackage.version} · {algorithmPackage.release_approved ? '已批准' : '实验/未批准'}</small>
                      </span>
                      {!algorithmPackage.active && (
                        <button
                          type="button"
                          onClick={() => onActivateSleepAlgorithm?.(algorithmPackage.package_id, algorithmPackage.version)}
                          disabled={!onActivateSleepAlgorithm || sleepRuntime.service_running || !algorithmPackage.compatible}
                        >
                          切换
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {!sleepRuntime.active_package.release_approved && (
                  <p className="algorithm-package-warning">
                    当前为实验算法，离线硬门槛未通过；不得作为正式结论，异常时请立即回滚。
                  </p>
                )}
                <button
                  className="algorithm-rollback-button"
                  type="button"
                  onClick={onRollbackSleepAlgorithm}
                  disabled={!onRollbackSleepAlgorithm || sleepRuntime.service_running || sleepRuntime.active_package.release_approved}
                >
                  <RotateCcw size={13} />回滚到上一稳定算法
                </button>
              </>
            )}
          </div>
        </details>
      </div>
      </>}

      {section === 'signal' && <>
      <SignalCalibrationSettings settings={settings.signalDisplay} onChange={signalDisplay=>update({signalDisplay})}/>
      <p className="setting-help">显示滤波开关与参数已移至每个页面的顶部工具栏；各页独立保存，不影响原始记录与算法输入。</p>

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
          <span className="field-label">底层量程（ADC）</span>
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
        <p className="setting-help">以下频带范围用于频带分离与功率计算；本页主波形的显示滤波在页面顶部调整。</p>
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

      <details className="setting-group pure-advanced-settings"><summary>专注视图频带参数（ADC量程）</summary>
        {createPureBands().map(band=><div className="two-col" key={band.key}>
          <label>{band.label}低频Hz<input type="number" step=".1" value={settings.eeg.pure.bandRanges[band.key].low}
            onChange={event=>updateEeg({pure:{...settings.eeg.pure,bandRanges:{...settings.eeg.pure.bandRanges,[band.key]:
              {...settings.eeg.pure.bandRanges[band.key],low:Number(event.target.value)}}}})}/></label>
          <label>{band.label}高频Hz<input type="number" step=".1" value={settings.eeg.pure.bandRanges[band.key].high}
            onChange={event=>updateEeg({pure:{...settings.eeg.pure,bandRanges:{...settings.eeg.pure.bandRanges,[band.key]:
              {...settings.eeg.pure.bandRanges[band.key],high:Number(event.target.value)}}}})}/></label>
          <label>{band.label}量程<ThemedSelect ariaLabel={band.label+'专注量程'} value={String(settings.eeg.pure.bandScales[band.key])}
            options={eegScaleOptions} onChange={value=>updateEeg({pure:{...settings.eeg.pure,bandScales:
              {...settings.eeg.pure.bandScales,[band.key]:parseAutoNumber(value)}}})}/></label>
        </div>)}
      </details>
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
      </>}

      {section === 'device' && (
        <div className="setting-group device-advanced-settings">
          <h3><span className="group-dot" />设备高级指令</h3>
          <p className="setting-help">仅在协议调试或工程排查时使用；常规采集无需发送。</p>
          <label>
            FFF5 十六进制指令
            <div className="settings-command-row">
              <input
                className="command-input"
                value={commandText}
                onChange={(event) => onCommandTextChange?.(event.target.value)}
                aria-label="十六进制命令"
                placeholder="AA 55 01 01"
              />
              <button type="button" onClick={onSendCommand} disabled={!connected || !onSendCommand}>
                <Send size={14} />发送
              </button>
            </div>
          </label>
          <small className="setting-help">设备未连接时禁止发送。采样率命令仍使用顶部的专用采样率按钮。</small>
        </div>
      )}

      {section === 'lsl' && lslStatus && (
        <LslSettingsSection
          settings={settings}
          status={lslStatus}
          pending={lslPending}
          onChange={onChange}
          onRefresh={onLslRefresh}
          onTestMarker={onLslTestMarker}
        />
      )}
    </aside>
  );
}

function SettingsTab({
  active,
  disabled = false,
  onClick,
  children
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={active ? 'is-active' : ''} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function BaselineCalibrationCard({
  title,
  instruction,
  progress,
  complete,
  running,
  reference,
  progressHint,
  duration,
  onStart,
  disabled = false
}: {
  title: string;
  instruction: string;
  progress: number;
  complete: boolean;
  running: boolean;
  reference?: string | null;
  progressHint: string;
  duration: string;
  onStart?: () => void;
  disabled?: boolean;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="baseline-calibration-card" data-state={complete ? 'complete' : running ? 'running' : 'idle'}>
      <div className="baseline-calibration-heading">
        <strong>{title}</strong>
        <span>{complete ? `已完成${reference ? ` · 参考强度 ${reference}` : ''}` : `${percent}% · ${duration}`}</span>
      </div>
      <div className="baseline-calibration-progress" aria-label={`${title}测量进度 ${percent}%`}>
        <span style={{ width: `${percent}%` }} />
        <em>{progressHint}</em>
      </div>
      <p>{instruction}</p>
      <button type="button" onClick={onStart} disabled={!onStart || disabled}>
        <RotateCcw size={12} />{complete ? '重新测量' : '开始测量'}
      </button>
    </div>
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
