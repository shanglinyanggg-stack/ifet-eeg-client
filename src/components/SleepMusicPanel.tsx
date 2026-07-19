import { useEffect, useState, type ComponentType } from 'react';
import {
  BrainCircuit,
  CircleAlert,
  Eye,
  Library,
  ListMusic,
  MoonStar,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  ShieldAlert,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Volume1,
  Volume2
} from 'lucide-react';
import { formatPlaybackTime, type MusicPlayerController } from '../domain/music-player';
import type { BlinkGestureSnapshot } from '../domain/blink-gesture';
import {
  blinkCalibrationFailureMessage,
  calibrationProgress,
  formatEnabledBlinkPairs,
  formatReferenceStrength,
  type SleepDemoSignalResponse
} from '../domain/sleep-demo-signal';
import type { SleepMetrics } from '../domain/sleep-metrics';
import type { SleepPhase, SleepSessionState } from '../domain/sleep-session';
import type { SleepMusicSettings } from '../domain/settings';
import type { SleepStagingStepResponse } from '../domain/sleep-staging-client';

export interface SleepMusicPanelProps {
  variant?: 'full' | 'compact';
  session: SleepSessionState;
  metrics: SleepMetrics | null;
  settings: SleepMusicSettings;
  player: MusicPlayerController;
  blink: BlinkGestureSnapshot;
  serviceStatus?: {
    phase: 'local' | 'checking' | 'warming' | 'ready' | 'fallback';
    message: string;
    chunksSeen: number;
    lastResponse?: SleepStagingStepResponse | null;
  };
  demoSignalStatus?: {
    phase: 'local' | 'calibrating' | 'ready' | 'fallback';
    message: string;
    alphaCalibrationSeconds: number;
    closedEyeCalibrationSeconds?: number;
    blinkCalibrationSeconds: number;
    lastResponse: SleepDemoSignalResponse | null;
  };
  onSelectTrack: (trackId: string) => void;
  onOpenLibrary: () => void;
  onRemoveTrack: (trackId: string) => void;
  onAutoModeChange: (enabled: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onOpenEyeCalibration?: () => void;
  onClosedEyeCalibration?: () => void;
  onBlinkCalibration: () => void;
  guidanceActive?: boolean;
  guidanceMessage?: string;
  onStartGuidance?: () => void;
  onStopGuidance?: () => void;
  onResetSession: () => void;
}

type PhaseMeta = {
  title: string;
  description: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
};

const PHASE_META: Record<SleepPhase, PhaseMeta> = {
  ready: {
    title: '等待进入放松',
    description: '脑电状态持续分析中',
    Icon: BrainCircuit
  },
  relaxing: {
    title: '放松已确认',
    description: 'Alpha 活动达到播放条件',
    Icon: Sparkles
  },
  transition: {
    title: '正在进入浅睡',
    description: '困意上升，音乐音量同步渐弱',
    Icon: MoonStar
  },
  'light-sleep': {
    title: '浅睡已确认',
    description: '音乐正在淡出并停止',
    Icon: MoonStar
  },
  'signal-poor': {
    title: '信号质量不足',
    description: '自动控制已保持上一状态',
    Icon: ShieldAlert
  }
};

export function SleepMusicPanel({
  variant = 'full',
  session,
  metrics,
  settings,
  player,
  blink,
  serviceStatus,
  demoSignalStatus,
  onSelectTrack,
  onOpenLibrary,
  onRemoveTrack,
  onAutoModeChange,
  onVolumeChange,
  onOpenEyeCalibration = () => undefined,
  onClosedEyeCalibration = () => undefined,
  onBlinkCalibration,
  guidanceActive = true,
  guidanceMessage,
  onStartGuidance = () => undefined,
  onStopGuidance = () => undefined,
  onResetSession
}: SleepMusicPanelProps) {
  const phase = PHASE_META[session.phase];
  const sourceLabel = session.source === 'demo'
    ? '演示控制'
    : session.source === 'demo-signal'
      ? 'PC v1.2 实时算法'
    : serviceStatus?.phase === 'checking'
      ? '算法连接中'
      : serviceStatus?.phase === 'warming'
        ? `算法预热 ${Math.min(30, serviceStatus.chunksSeen * 5)}/30s`
        : serviceStatus?.phase === 'ready' || session.source === 'service'
          ? 'PC 睡眠算法'
          : serviceStatus?.phase === 'fallback'
            ? '本地降级'
            : '本地实时判定';
  const actionLabel = guidanceActive ? resolveActionLabel(session, settings) : '等待点击开始助眠';
  const progress = resolveStageProgress(session, settings);
  const currentTime = formatPlaybackTime(player.snapshot.currentTime);
  const duration = formatPlaybackTime(player.snapshot.duration);
  const [announcing, setAnnouncing] = useState(false);
  const algorithmAlphaRatio = demoSignalStatus?.lastResponse?.telemetry.alpha_ratio ?? null;
  const algorithmAlphaThreshold = demoSignalStatus?.lastResponse?.telemetry.alpha_on_threshold ?? null;
  const stagingResponse = serviceStatus?.lastResponse ?? null;
  const drowsiness = stagingResponse?.decision_valid && stagingResponse.selected_sleep_probability !== null
    ? Math.round(stagingResponse.selected_sleep_probability * 100)
    : null;
  const realtimeStage = resolveRealtimeStage(serviceStatus?.phase, stagingResponse);

  useEffect(() => {
    if (!settings.audienceCues || session.phase === 'ready') {
      setAnnouncing(false);
      return;
    }
    setAnnouncing(true);
    if (session.phase === 'signal-poor') return;
    const timer = window.setTimeout(() => setAnnouncing(false), 4_200);
    return () => window.clearTimeout(timer);
  }, [session.enteredAtMs, session.phase, settings.audienceCues]);

  if (variant === 'compact') {
    return (
      <section className="panel sleep-music-panel is-compact" data-phase={session.phase} data-announcing={announcing} aria-label="睡眠音乐引导">
        <div className="sleep-music-compact-main">
          <span className="sleep-stage-icon"><phase.Icon size={18} /></span>
          <div className="sleep-stage-copy" aria-live="polite">
            <strong>{phase.title}</strong>
            <span>{actionLabel}</span>
          </div>
          <span className="sleep-source-badge"><Radio size={12} />{sourceLabel}</span>
          <button
            type="button"
            className={`sleep-guidance-button is-compact ${guidanceActive ? 'is-active' : ''}`}
            onClick={guidanceActive ? onStopGuidance : onStartGuidance}
            aria-label={guidanceActive ? '结束助眠' : '开始助眠'}
          >
            {guidanceActive ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button type="button" className="sleep-library-button is-icon" onClick={onOpenLibrary} aria-label="打开助眠音乐库" title="音乐库">
            <Library size={14} />
          </button>
        </div>
        <div className="sleep-music-compact-player">
          <button type="button" className="player-icon-button" onClick={() => void player.toggle()} aria-label={player.snapshot.playing ? '暂停音乐' : '播放音乐'}>
            {player.snapshot.playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div className="sleep-track-copy">
            <strong>{player.selectedTrack?.name ?? '尚未选择音乐'}</strong>
            <span>{Math.round(player.snapshot.volume * 100)}% · {currentTime}/{duration}</span>
          </div>
          <div className="sleep-stage-meter" aria-label={`阶段进度 ${Math.round(progress)}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
        <DemoSignalTelemetry
          status={demoSignalStatus}
          blink={blink}
          blinkEnabled={settings.blinkControlEnabled}
          onOpenEyeCalibration={onOpenEyeCalibration}
          onClosedEyeCalibration={onClosedEyeCalibration}
          onBlinkCalibration={onBlinkCalibration}
          compact
        />
      </section>
    );
  }

  return (
    <section className="panel sleep-music-panel" data-phase={session.phase} data-announcing={announcing} aria-label="睡眠音乐引导">
      <header className="panel-header sleep-music-header">
        <h2><Music2 size={15} />睡眠音乐引导</h2>
        <div className="sleep-music-badges">
          <span className="sleep-source-badge"><Radio size={12} />{sourceLabel}</span>
          <button
            type="button"
            className={`sleep-guidance-button ${guidanceActive ? 'is-active' : ''}`}
            onClick={guidanceActive ? onStopGuidance : onStartGuidance}
          >
            {guidanceActive ? <Pause size={14} /> : <Play size={14} />}
            <span>{guidanceActive ? '结束助眠' : '开始助眠'}</span>
          </button>
          <button type="button" className="sleep-library-button" onClick={onOpenLibrary} title="打开音乐库">
            <Library size={14} /><span>音乐库</span>
          </button>
          <button type="button" className="sleep-reset-button" onClick={onResetSession} title="开始新的睡眠演示" aria-label="重置睡眠演示">
            <RotateCcw size={14} />
          </button>
        </div>
      </header>

      <div className="sleep-stage-band">
        <span className="sleep-stage-icon"><phase.Icon size={22} strokeWidth={1.8} /></span>
        <div className="sleep-stage-copy" aria-live="polite">
          <strong>{phase.title}</strong>
          <span>{!guidanceActive && guidanceMessage
            ? guidanceMessage
            : session.reason === 'service-warmup' && serviceStatus
              ? serviceStatus.message
              : phase.description}</span>
        </div>
        <strong className="sleep-action-label">{actionLabel}</strong>
        <div className="sleep-stage-meter" aria-label={`阶段进度 ${Math.round(progress)}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="sleep-stage-kpis">
          <span title="当前 Alpha 相对个体睁眼基线">
            Alpha <strong>{algorithmAlphaRatio === null ? `${Math.round((metrics?.alphaRelative ?? session.alphaEma) * 100)}%` : `${Math.round(algorithmAlphaRatio * 100)}%`}</strong>
            {algorithmAlphaThreshold !== null && <small>阈值 {Math.round(algorithmAlphaThreshold * 100)}%</small>}
          </span>
          <span title="PC 分期算法保守睡眠概率">
            困意 <strong>{drowsiness === null ? `${Math.round(metrics?.sleepOnsetScore ?? session.sleepScoreEma)}` : `${drowsiness}%`}</strong>
            <small>{realtimeStage}</small>
          </span>
          <span>质量 <strong>{Math.round(session.coverage * 100)}%</strong></span>
        </div>
      </div>

      <DemoSignalTelemetry
        status={demoSignalStatus}
        blink={blink}
        blinkEnabled={settings.blinkControlEnabled}
        onOpenEyeCalibration={onOpenEyeCalibration}
        onClosedEyeCalibration={onClosedEyeCalibration}
        onBlinkCalibration={onBlinkCalibration}
      />

      <div className="sleep-track-slots" role="list" aria-label="演示曲目">
        {Array.from({ length: 3 }, (_, index) => {
          const track = settings.tracks[index];
          if (!track) {
            return (
              <button key={`empty-${index}`} type="button" className="sleep-track-slot is-empty" onClick={onOpenLibrary}>
                <Plus size={15} />
                <span>添加音乐</span>
              </button>
            );
          }
          const selected = player.selectedTrack?.id === track.id;
          return (
            <div className={`sleep-track-slot ${selected ? 'is-selected' : ''}`} key={track.id} role="listitem">
              <button type="button" className="sleep-track-select" onClick={() => onSelectTrack(track.id)} aria-pressed={selected}>
                <span className="sleep-track-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="sleep-track-name">{track.name}</span>
              </button>
              <button type="button" className="sleep-track-remove" onClick={() => onRemoveTrack(track.id)} title="移除曲目" aria-label={`移除 ${track.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="sleep-player-row">
        <div className="sleep-player-controls">
          <button type="button" className="player-icon-button" onClick={player.previous} title="上一首" aria-label="上一首">
            <SkipBack size={16} />
          </button>
          <button type="button" className="player-icon-button is-primary" onClick={() => void player.toggle()} aria-label={player.snapshot.playing ? '暂停音乐' : '播放音乐'}>
            {player.snapshot.playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" className="player-icon-button" onClick={player.next} title="下一首" aria-label="下一首">
            <SkipForward size={16} />
          </button>
        </div>
        <div className="sleep-now-playing">
          <span><ListMusic size={13} />正在播放</span>
          <strong>{player.selectedTrack?.name ?? '请选择本地音乐'}</strong>
        </div>
        <span className="sleep-player-time">{currentTime} / {duration}</span>
      </div>

      <input
        className="sleep-progress-range"
        type="range"
        min={0}
        max={Math.max(1, player.snapshot.duration)}
        step={0.1}
        value={Math.min(player.snapshot.currentTime, Math.max(1, player.snapshot.duration))}
        onChange={(event) => player.seek(Number(event.target.value))}
        disabled={player.snapshot.duration <= 0}
        aria-label="音乐播放进度"
      />

      <div className="sleep-player-footer">
        <label className="sleep-volume-control">
          {player.snapshot.volume > 0.35 ? <Volume2 size={15} /> : <Volume1 size={15} />}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={player.snapshot.volume}
            onChange={(event) => {
              const volume = Number(event.target.value);
              player.setVolume(volume);
              onVolumeChange(volume);
            }}
            aria-label="音乐音量"
          />
          <strong>{Math.round(player.snapshot.volume * 100)}%</strong>
        </label>
        <label className="sleep-auto-toggle">
          <input type="checkbox" checked={settings.autoMode} onChange={(event) => onAutoModeChange(event.target.checked)} />
          <span>自动控制</span>
        </label>
        {settings.blinkControlEnabled && (
          <span className="sleep-blink-status" title="三次眨眼降低 10%，五次眨眼提高 10%">
            <Eye size={14} />眨眼 {blink.count}
          </span>
        )}
      </div>

      {(player.snapshot.error || player.snapshot.autoplayBlocked) && (
        <div className="sleep-player-error" role="status">
          <CircleAlert size={14} />{player.snapshot.error}
        </div>
      )}
    </section>
  );
}

function DemoSignalTelemetry({
  status,
  blink,
  blinkEnabled,
  onOpenEyeCalibration,
  onClosedEyeCalibration,
  onBlinkCalibration,
  compact = false
}: {
  status: SleepMusicPanelProps['demoSignalStatus'];
  blink: BlinkGestureSnapshot;
  blinkEnabled: boolean;
  onOpenEyeCalibration: () => void;
  onClosedEyeCalibration: () => void;
  onBlinkCalibration: () => void;
  compact?: boolean;
}) {
  const response = status?.lastResponse ?? null;
  const blinkStatus = response?.state.blink_calibration_status ?? blink.calibrationStatus;
  const stale = response?.state.blink_baseline_stale ?? blink.baselineStale;
  if (!status && !blinkEnabled && blinkStatus === 'idle') return null;
  const alphaProgress = calibrationProgress(
    response,
    status?.alphaCalibrationSeconds ?? 20,
    response?.state.calibration_complete ?? false,
    response?.state.calibration_progress
  );
  const blinkProgress = calibrationProgress(
    response,
    status?.blinkCalibrationSeconds ?? 10,
    response?.state.blink_calibration_complete ?? blinkStatus === 'complete',
    response?.state.blink_calibration_progress ?? blink.calibrationProgress
  );
  const closedEyeProgress = calibrationProgress(
    response,
    status?.closedEyeCalibrationSeconds ?? 20,
    response?.state.closed_eye_calibration_complete ?? false,
    response?.state.closed_eye_calibration_progress
  );
  const telemetry = response?.telemetry;
  const alphaLevel = Math.round((telemetry?.alpha_level ?? 0) * 100);
  const recommendedVolume = Math.round((telemetry?.recommended_volume ?? 0) * 100);
  const pendingBlinks = response?.state.blink_count_pending ?? blink.count;
  const peakCount = telemetry?.blink_calibration_peak_count ?? blink.calibrationPeakCount;
  const consensus = telemetry?.blink_calibration_consensus_fraction ?? blink.calibrationConsensus;
  const rejected = telemetry?.blink_single_channel_rejections ?? blink.singleChannelRejections ?? 0;
  const gapRejected = telemetry?.blink_invalid_gap_rejections ?? blink.invalidGapRejections ?? 0;
  const recovered = telemetry?.blink_gap_recoveries ?? blink.gapRecoveries ?? 0;
  const healthChecks = telemetry?.blink_baseline_health_checks ?? blink.baselineHealthChecks ?? 0;
  const recoveryProgress = telemetry?.blink_baseline_recovery_progress ?? blink.baselineRecoveryProgress ?? 0;
  const baselineRecoveries = telemetry?.blink_baseline_recoveries ?? blink.baselineRecoveries ?? 0;
  const disabledPairs = formatEnabledBlinkPairs(
    telemetry?.blink_runtime_disabled_pairs ?? blink.runtimeDisabledPairs ?? []
  );
  const alphaRatio = telemetry?.alpha_ratio ?? null;
  const alphaOnThreshold = telemetry?.alpha_on_threshold ?? null;
  const alphaRatioPercent = alphaRatio === null ? 0 : clampPercent(alphaRatio * 100);
  const alphaThresholdPercent = alphaOnThreshold === null ? 0 : clampPercent(alphaOnThreshold * 100);
  const initialBaseline = telemetry?.open_eye_alpha_initial_baseline ?? null;
  const currentBaseline = telemetry?.open_eye_alpha_baseline ?? null;
  const baselineChange = initialBaseline !== null && currentBaseline !== null && Math.abs(initialBaseline) > 1e-6
    ? ((currentBaseline - initialBaseline) / Math.abs(initialBaseline)) * 100
    : null;
  const enabledPairs = formatEnabledBlinkPairs(
    telemetry?.blink_enabled_channel_pairs ?? blink.enabledPairs ?? []
  );
  const openEyeProgressHint = response?.state.calibration_complete
    ? `参考 ${formatReferenceStrength(telemetry?.open_eye_alpha_baseline) ?? '--'}`
    : '睁眼平视，保持静止';
  const closedEyeProgressHint = response?.state.closed_eye_calibration_complete
    ? `参考 ${formatReferenceStrength(telemetry?.closed_eye_alpha_reference) ?? '--'}`
    : response?.state.calibration_complete
      ? '自然闭眼，保持清醒'
      : '先测睁眼基线';
  const blinkProgressHint = stale
    ? '漂移恢复中'
    : blinkStatus === 'complete'
      ? `阈值 ${formatReferenceStrength(telemetry?.blink_threshold_robust_z, ' z') ?? '--'}`
      : blinkStatus === 'running'
        ? blinkProgress < 3 / 13
          ? '前 3 秒保持静止'
          : '连续自然眨眼'
        : '先静止 3 秒';
  const failure = blinkCalibrationFailureMessage(
    response?.state.blink_calibration_failure_reason ?? blink.calibrationFailureReason
  );
  const state = status?.phase ?? 'local';
  const calibrationLabel = stale
    ? `自动恢复 ${Math.round(recoveryProgress * 100)}%`
    : blinkStatus === 'complete'
      ? `${pendingBlinks} 次待确认`
      : blinkStatus === 'running'
        ? `${Math.round(blinkProgress * 100)}% 测量`
        : blinkStatus === 'failed'
          ? '测量失败'
          : '待测量';

  if (compact) {
    return (
      <div className="sleep-demo-telemetry is-compact" data-state={state} data-blink-state={stale ? 'stale' : blinkStatus} aria-label="Alpha 与眨眼配对遥测">
        <span><i>Alpha</i><strong>{response?.state.calibration_complete ? `${alphaLevel}%` : response ? `${Math.round(alphaProgress * 100)}% 校准` : '本地'}</strong></span>
        <span><i>配对</i><strong>{enabledPairs}</strong></span>
        <span><i>目标音量</i><strong>{recommendedVolume}%</strong></span>
        <span><i>眨眼</i><strong>{calibrationLabel}</strong></span>
        <button
          type="button"
          className="sleep-blink-calibration-button is-compact"
          onClick={onBlinkCalibration}
          title={blinkStatus === 'complete' && !stale ? '重新测量眨眼基线' : '开始 3+10 秒眨眼测量'}
          aria-label={blinkStatus === 'complete' && !stale ? '重新测量眨眼基线' : '开始 3+10 秒眨眼测量'}
        >
          <RotateCcw size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="sleep-demo-telemetry" data-state={state} data-blink-state={stale ? 'stale' : blinkStatus} aria-label="Alpha 与眨眼配对算法遥测">
      <div className="sleep-demo-calibration">
        <span className="sleep-demo-label">睁眼基线</span>
        <div className="sleep-demo-progress" aria-label={`睁眼基线校准 ${Math.round(alphaProgress * 100)}%`}>
          <span style={{ width: `${alphaProgress * 100}%` }} />
          <em>{openEyeProgressHint}</em>
        </div>
        <strong>{response?.state.calibration_complete ? '就绪' : response ? `${Math.round(alphaProgress * 100)}%` : '本地'}</strong>
        <button type="button" className="sleep-blink-calibration-button" onClick={onOpenEyeCalibration}>
          <RotateCcw size={13} />{response?.state.calibration_complete ? '重新测量' : '开始测量'}
        </button>
      </div>
      <div className="sleep-demo-calibration is-closed-eye">
        <span className="sleep-demo-label">闭眼基线</span>
        <div className="sleep-demo-progress" aria-label={`闭眼基线校准 ${Math.round(closedEyeProgress * 100)}%`}>
          <span style={{ width: `${closedEyeProgress * 100}%` }} />
          <em>{closedEyeProgressHint}</em>
        </div>
        <strong>{response?.state.closed_eye_calibration_complete ? '就绪' : `${Math.round(closedEyeProgress * 100)}%`}</strong>
        <button
          type="button"
          className="sleep-blink-calibration-button"
          onClick={onClosedEyeCalibration}
          disabled={!response?.state.calibration_complete}
        >
          <Eye size={13} />{response?.state.closed_eye_calibration_complete ? '重新测量' : '开始测量'}
        </button>
      </div>
      <div className="sleep-demo-calibration is-blink">
        <span className="sleep-demo-label">眨眼配对</span>
        <div className="sleep-demo-progress" aria-label={`眨眼测量 ${Math.round(blinkProgress * 100)}%`}>
          <span style={{ width: `${blinkProgress * 100}%` }} />
          <em>{blinkProgressHint}</em>
        </div>
        <strong>{stale ? '漂移' : blinkStatus === 'complete' ? '就绪' : blinkStatus === 'running' ? `${Math.round(blinkProgress * 100)}%` : '未就绪'}</strong>
        <button type="button" className="sleep-blink-calibration-button" onClick={onBlinkCalibration}>
          <Eye size={13} />{blinkStatus === 'complete' && !stale ? '重新测量' : '测量 3+10 秒'}
        </button>
      </div>
      <div className="sleep-demo-kpi">
        <span>Alpha 水平</span>
        <strong>{alphaLevel}%</strong>
      </div>
      <div className="sleep-demo-kpi is-alpha-threshold">
        <span>Alpha 占比 / 开启阈值</span>
        <strong>{alphaRatio === null ? '--' : `${Math.round(alphaRatioPercent)}%`}<small> / {alphaOnThreshold === null ? '--' : `${Math.round(alphaThresholdPercent)}%`}</small></strong>
        <div className="sleep-alpha-threshold-track" aria-label={`Alpha 占比 ${Math.round(alphaRatioPercent)}%，开启阈值 ${Math.round(alphaThresholdPercent)}%`}>
          <span style={{ width: `${alphaRatioPercent}%` }} />
          {alphaOnThreshold !== null && <i style={{ left: `${alphaThresholdPercent}%` }} title="音乐开启阈值" />}
        </div>
      </div>
      <div className="sleep-demo-kpi">
        <span>睁眼基线变化</span>
        <strong>{baselineChange === null ? '--' : `${baselineChange >= 0 ? '+' : ''}${baselineChange.toFixed(1)}%`}</strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>推荐音量</span>
        <strong>{recommendedVolume}%</strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>启用配对</span>
        <strong>{enabledPairs}</strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>配对有效峰</span>
        <strong>{peakCount}<small> / 5+</small></strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>配对一致率</span>
        <strong>{Math.round(consensus * 100)}%<small> / 65%</small></strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>待确认眨眼</span>
        <strong>{pendingBlinks}<small> / 3·5</small></strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>单通道拒绝</span>
        <strong>{rejected}</strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>丢包拒绝 / 补偿</span>
        <strong>{gapRejected}<small> / {recovered}</small></strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>基线健康检查</span>
        <strong>{healthChecks}</strong>
      </div>
      <div className="sleep-demo-kpi">
        <span>自动恢复 / 暂停配对</span>
        <strong>{stale ? `${Math.round(recoveryProgress * 100)}%` : baselineRecoveries}<small> / {disabledPairs}</small></strong>
      </div>
      {(blinkStatus !== 'complete' || stale || status?.phase === 'fallback') && (
        <div className="sleep-blink-calibration-notice" role="status">
          {blinkStatus === 'running' && !stale ? <Eye size={14} /> : <ShieldAlert size={14} />}
          <span>{stale
            ? `基线漂移超限，眨眼控制已暂停；稳定安静信号自动恢复中（${Math.round(recoveryProgress * 100)}%），也可立即重新测量`
            : blinkStatus === 'running'
              ? '先 3 秒睁眼安静不眨眼，再每 0.5-1 秒自然眨眼一次，保持头部和下颌静止'
              : failure || (blinkStatus === 'idle'
                ? '需先完成 3 秒安静 + 10 秒眨眼测量'
                : status?.message)}</span>
          {blinkStatus !== 'running' && (
            <button
              type="button"
              className="sleep-blink-calibration-button is-notice-action"
              onClick={onBlinkCalibration}
            >
              <RotateCcw size={12} />{blinkStatus === 'failed' || stale ? '重试' : '开始测量'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function resolveRealtimeStage(
  phase: 'local' | 'checking' | 'warming' | 'ready' | 'fallback' | undefined,
  response: SleepStagingStepResponse | null
): string {
  if (phase === 'fallback') return '本地降级';
  if (phase === 'checking') return '连接中';
  if (!response?.decision_valid) return phase === 'warming' ? '分期预热' : '等待分期';
  if (response.selected_stage === 'W') return 'W 清醒';
  if (response.selected_stage === 'NREM') return 'NREM';
  if (response.selected_stage === 'REM') return 'REM';
  return '等待分期';
}

function resolveActionLabel(session: SleepSessionState, settings: SleepMusicSettings): string {
  if (!settings.enabled) return '音乐引导已关闭';
  if (settings.tracks.length === 0) return '等待选择音乐';
  if (!settings.autoMode) return '人工控制中';
  if (session.reason === 'service-warmup') return '等待 30 秒有效分期';
  if (session.reason === 'demo-alpha-calibrating') return '正在建立个体 Alpha 基线';
  if (session.action === 'play') return '自动开始播放';
  if (session.action === 'fade') return `渐弱至 ${Math.round(session.targetVolume * 100)}%`;
  if (session.action === 'stop') return '淡出并停止';
  return session.phase === 'signal-poor' ? '保持上一状态' : '等待自动触发';
}

function resolveStageProgress(session: SleepSessionState, settings: SleepMusicSettings): number {
  if (session.phase === 'signal-poor') return clampPercent(session.coverage * 100);
  if (session.phase === 'light-sleep') return 100;
  if (session.phase === 'transition') {
    const range = Math.max(1, settings.stopSleepScoreThreshold - settings.fadeSleepScoreThreshold);
    return clampPercent(45 + ((session.sleepScoreEma - settings.fadeSleepScoreThreshold) / range) * 55);
  }
  const alphaProgress = session.alphaEma / Math.max(0.01, settings.relaxAlphaThreshold);
  return clampPercent(alphaProgress * (session.phase === 'relaxing' ? 55 : 45));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}
