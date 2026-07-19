import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Activity, Palette, Settings2 } from 'lucide-react';
import { appendSamples, FilterChain, KalmanFilter, StreamingFilterCache, type TimedValue } from './domain/dsp';
import { BlinkGestureDetector, type BlinkGestureSnapshot } from './domain/blink-gesture';
import { mergeAudioTracks, pickAudioTracks, revokeAudioTrack } from './domain/audio-tracks';
import { createDemoSamples, DEMO_SAMPLE_RATE } from './domain/demo';
import {
  DEFAULT_ALPHA_CALIBRATION_SECONDS,
  DEFAULT_BLINK_CALIBRATION_SECONDS,
  type SleepDemoSignalResponse
} from './domain/sleep-demo-signal';
import {
  resolveEegShareListColumns,
  resolveNormalGridColumns,
  resolveSettingsFormColumns,
  resolveSettingsPanelWidth,
  resolveViewportDensity
} from './domain/layout';
import {
  advanceSleepSession,
  createSleepSessionState,
  type SleepSessionConfig
} from './domain/sleep-session';
import {
  getSleepStagingHealth,
  configureSleepDemo,
  openSleepStagingDirectory,
  prepareSleepStagingRuntime,
  resetSleepDemo,
  resetSleepStaging,
  setSleepDemoBlinkEnabled,
  startSleepDemoBlinkCalibration,
  startSleepStagingService,
  stopSleepStagingService,
  submitSleepDemoStep,
  submitSleepStagingStep,
  toServiceObservation,
  type SleepStagingHealth,
  type SleepStagingRuntimeInfo,
  type SleepStagingStepResponse
} from './domain/sleep-staging-client';
import {
  SleepDemoChunkAssembler,
  SleepStagingChunkAssembler,
  signedU24,
  type SleepDemoStepRequest,
  type SleepStagingStepRequest
} from './domain/sleep-staging-stream';
import type { SleepMetrics } from './domain/sleep-metrics';
import {
  loadSettings,
  saveSettings,
  themeOptions,
  type AppSettings,
  type ThemeName
} from './domain/settings';
import { SampleBatcher } from './domain/sample-batcher';
import {
  channelColors,
  channelLabels,
  type ChannelKey,
  type DeviceInfo,
  type SampleEvent,
  type StatusEvent
} from './domain/protocol';
import { DevicePanel } from './components/DevicePanel';
import { EegModeView } from './components/EegModeView';
import { MusicLibraryModal } from './components/MusicLibraryModal';
import { PureWaveformView } from './components/PureWaveformView';
import { SettingsPanel } from './components/SettingsPanel';
import { ThemedSelect } from './components/ThemedSelect';
import { WaveformCanvas } from './components/WaveformCanvas';
import { useMusicPlayer } from './hooks/useMusicPlayer';

const MAX_POINTS = 1200;
const SAMPLE_FLUSH_INTERVAL_MS = 50;
const allChannels = Object.keys(channelLabels) as ChannelKey[];

type ChannelBuffers = Record<ChannelKey, TimedValue[]>;
type AppStyle = CSSProperties & {
  '--normal-columns': number;
  '--settings-panel-width': string;
  '--settings-form-columns': number;
  '--share-list-columns': number;
};

type SleepServicePhase = 'local' | 'checking' | 'warming' | 'ready' | 'fallback';

interface SleepServiceUiState {
  phase: SleepServicePhase;
  message: string;
  chunksSeen: number;
  lastResponse: SleepStagingStepResponse | null;
}

type SleepDemoServicePhase = 'local' | 'calibrating' | 'ready' | 'fallback';

interface SleepDemoServiceUiState {
  phase: SleepDemoServicePhase;
  message: string;
  alphaCalibrationSeconds: number;
  blinkCalibrationSeconds: number;
  lastResponse: SleepDemoSignalResponse | null;
}

function createEmptyBuffers(): ChannelBuffers {
  return allChannels.reduce((acc, channel) => {
    acc[channel] = [];
    return acc;
  }, {} as ChannelBuffers);
}

function extractChannelValues(event: SampleEvent): Partial<Record<ChannelKey, number>> {
  const ppg = event.packet.ppg;
  const eeg = event.packet.eeg;
  return {
    ir1: ppg.ir1,
    red1: ppg.red1,
    green1: ppg.green1,
    ir2: ppg.ir2,
    red2: ppg.red2,
    green2: ppg.green2,
    accX: ppg.accX,
    accY: ppg.accY,
    accZ: ppg.accZ,
    eeg1: eeg?.eeg1,
    eeg2: eeg?.eeg2,
    eeg3: eeg?.eeg3,
    eeg4: eeg?.eeg4
  };
}

function mergeSampleEvents(current: ChannelBuffers, events: SampleEvent[]): ChannelBuffers {
  const next: ChannelBuffers = { ...current };
  const pending = allChannels.reduce((acc, channel) => {
    acc[channel] = [];
    return acc;
  }, {} as ChannelBuffers);
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp) || Date.now();
    const values = extractChannelValues(event);
    for (const [channel, value] of Object.entries(values) as [ChannelKey, number | undefined][]) {
      if (typeof value === 'number') {
        pending[channel].push({ timestamp, value });
      }
    }
  }
  for (const channel of allChannels) {
    next[channel] = appendSamples(current[channel], pending[channel], MAX_POINTS);
  }
  return next;
}

function blinkSnapshotFromResponse(
  response: SleepDemoSignalResponse,
  previous: BlinkGestureSnapshot
): BlinkGestureSnapshot {
  return {
    count: response.state.blink_count_pending,
    lastBlinkMs: response.events.some((event) => event.flag === 'BLINK')
      ? Date.now()
      : previous.lastBlinkMs,
    confirmationRemainingMs: 0,
    calibrationStatus: response.state.blink_calibration_status,
    calibrationProgress: response.state.blink_calibration_progress,
    calibrationFailureReason: response.state.blink_calibration_failure_reason,
    calibrationPeakCount: response.telemetry.blink_calibration_peak_count,
    calibrationConsensus: response.telemetry.blink_calibration_consensus_fraction,
    enabledPairs: (response.telemetry.blink_enabled_channel_pairs ?? []).map((pair) => [pair[0], pair[1]] as const),
    baselineStale: response.state.blink_baseline_stale ?? false,
    baselineHealthChecks: response.telemetry.blink_baseline_health_checks ?? 0,
    adaptiveBaselineUpdates: response.telemetry.blink_adaptive_baseline_updates,
    singleChannelRejections: response.telemetry.blink_single_channel_rejections,
    invalidGapRejections: response.telemetry.blink_invalid_gap_rejections ?? 0,
    gapRecoveries: response.telemetry.blink_gap_recoveries ?? 0
  };
}

export default function App() {
  const blinkDetector = useRef(new BlinkGestureDetector());
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [viewport, setViewport] = useState(() => getViewportSize());
  const [buffers, setBuffers] = useState<ChannelBuffers>(() => createEmptyBuffers());
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordPath, setRecordPath] = useState('');
  const [status, setStatus] = useState('待机');
  const [commandText, setCommandText] = useState('AA 55 01 01');
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [musicLibraryOpen, setMusicLibraryOpen] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [warmupRemaining, setWarmupRemaining] = useState(0);
  const [sleepMetrics, setSleepMetrics] = useState<SleepMetrics | null>(null);
  const sleepConfig = useMemo(
    () => toSleepSessionConfig(settings),
    [settings.sleepMusic]
  );
  const [sleepSession, setSleepSession] = useState(() =>
    createSleepSessionState(toSleepSessionConfig(settings))
  );
  const [blinkSnapshot, setBlinkSnapshot] = useState<BlinkGestureSnapshot>(() =>
    blinkDetector.current.snapshot()
  );
  const [blinkVolumeOffset, setBlinkVolumeOffset] = useState(0);
  const [sleepService, setSleepService] = useState<SleepServiceUiState>({
    phase: 'local',
    message: '本地实时判定',
    chunksSeen: 0,
    lastResponse: null
  });
  const [sleepDemoService, setSleepDemoService] = useState<SleepDemoServiceUiState>({
    phase: 'local',
    message: '本地 Alpha / 眨眼检测',
    alphaCalibrationSeconds: DEFAULT_ALPHA_CALIBRATION_SECONDS,
    blinkCalibrationSeconds: DEFAULT_BLINK_CALIBRATION_SECONDS,
    lastResponse: null
  });
  const [sleepRuntime, setSleepRuntime] = useState<SleepStagingRuntimeInfo | null>(null);
  const lastConnectedDevice = useRef('');
  const reconnectAttempt = useRef(0);
  const settingsRef = useRef(settings);
  const lastBlinkSampleTimestamp = useRef(0);
  const sleepAssembler = useRef(new SleepStagingChunkAssembler(createSleepSessionId()));
  const sleepDemoAssembler = useRef(new SleepDemoChunkAssembler(sleepAssembler.current.currentSessionId));
  const sleepStepQueue = useRef<Promise<void>>(Promise.resolve());
  const sleepDemoStepQueue = useRef<Promise<void>>(Promise.resolve());
  const remoteStagingSession = useRef<string | null>(null);
  const remoteBlinkState = useRef<{ sessionId: string; enabled: boolean } | null>(null);
  const resumeAfterLibraryRef = useRef(false);
  const lastDemoGestureTimestamp = useRef(-1);
  const lastAppliedDemoTimestamp = useRef(-1);

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const handleResize = () => setViewport(getViewportSize());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!settings.sleepMusic.serviceEnabled || !isTauriRuntime()) {
      setSleepService({
        phase: 'local',
        message: '本地实时判定',
        chunksSeen: 0,
        lastResponse: null
      });
      setSleepDemoService({
        phase: 'local',
        message: '本地 Alpha / 眨眼检测',
        alphaCalibrationSeconds: DEFAULT_ALPHA_CALIBRATION_SECONDS,
        blinkCalibrationSeconds: DEFAULT_BLINK_CALIBRATION_SECONDS,
        lastResponse: null
      });
      remoteStagingSession.current = null;
      remoteBlinkState.current = null;
      return;
    }

    setSleepService((current) => ({
      ...current,
      phase: 'checking',
      message: '正在检测 PC 睡眠算法',
      lastResponse: null
    }));
    remoteStagingSession.current = null;
    lastAppliedDemoTimestamp.current = -1;
    lastDemoGestureTimestamp.current = -1;
    setSleepDemoService((current) => ({
      ...current,
      phase: 'calibrating',
      message: '正在连接 v1.2 Alpha / 眨眼算法',
      lastResponse: null
    }));
    const endpoint = settings.sleepMusic.serviceEndpoint;
    let preparedRuntime: SleepStagingRuntimeInfo | null = null;
    void prepareSleepStagingRuntime()
      .then(async (runtime) => {
        if (cancelled) throw new Error('cancelled');
        preparedRuntime = runtime;
        setSleepRuntime(runtime);
        try {
          return await getSleepStagingHealth(endpoint);
        } catch (healthError) {
          if (!runtime.venv_ready) throw healthError;
          const started = await startSleepStagingService(endpointPort(endpoint));
          setSleepRuntime(started);
          return waitForSleepStagingHealth(endpoint);
        }
      })
      .then(async (health) => {
        const sessionId = sleepAssembler.current.currentSessionId;
        const blinkEnabled = settingsRef.current.sleepMusic.blinkControlEnabled;
        const [stagingHealth, demoResponse] = await Promise.all([
          resetSleepStaging(endpoint, sessionId),
          resetSleepDemo(endpoint, sessionId, blinkEnabled)
        ]);
        remoteStagingSession.current = sessionId;
        remoteBlinkState.current = { sessionId, enabled: blinkEnabled };
        return { health, stagingHealth, demoResponse };
      })
      .then(({ health, stagingHealth, demoResponse }) => {
        if (cancelled) return;
        setSleepService({
          phase: 'warming',
          message: 'PC 算法预热 0/30s',
          chunksSeen: stagingHealth.chunks_seen ?? 0,
          lastResponse: null
        });
        setSleepDemoService({
          phase: 'calibrating',
          message: 'Alpha 20s 校准中 · 眨眼需单独测量 3+10s',
          alphaCalibrationSeconds: health.demo?.calibration_seconds
            ?? DEFAULT_ALPHA_CALIBRATION_SECONDS,
          blinkCalibrationSeconds: health.demo?.blink_calibration_seconds
            ?? DEFAULT_BLINK_CALIBRATION_SECONDS,
          lastResponse: demoResponse
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setSleepService({
          phase: 'fallback',
          message: preparedRuntime?.venv_ready
            ? 'PC 服务不可用，已切换本地判定'
            : '算法环境未安装，已使用本地判定',
          chunksSeen: 0,
          lastResponse: null
        });
        setSleepDemoService({
          phase: 'fallback',
          message: 'v1.2 Demo 算法不可用，已使用本地检测',
          alphaCalibrationSeconds: DEFAULT_ALPHA_CALIBRATION_SECONDS,
          blinkCalibrationSeconds: DEFAULT_BLINK_CALIBRATION_SECONDS,
          lastResponse: null
        });
        remoteStagingSession.current = null;
        remoteBlinkState.current = null;
        console.warn('Sleep staging service unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.sleepMusic.serviceEnabled, settings.sleepMusic.serviceEndpoint]);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      const macFullscreenShortcut = event.key.toLowerCase() === 'f'
        && event.metaKey
        && event.ctrlKey;
      if (event.key !== 'F11' && !macFullscreenShortcut) return;
      event.preventDefault();
      await toggleFullscreen();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const sampleBatcher = useRef<SampleBatcher<SampleEvent> | null>(null);
  const enqueueSleepChunks = useCallback((chunks: SleepStagingStepRequest[]) => {
    for (const chunk of chunks) {
      sleepStepQueue.current = sleepStepQueue.current.then(async () => {
        const current = settingsRef.current.sleepMusic;
        if (
          !current.serviceEnabled
          || !isTauriRuntime()
          || remoteStagingSession.current !== chunk.session_id
        ) return;
        try {
          const response = await submitSleepStagingStep(current.serviceEndpoint, chunk);
          setSleepService((previous) => {
            const chunksSeen = response.chunks_seen
              ?? (response.end_seconds ? Math.max(1, Math.round(response.end_seconds / 5)) : previous.chunksSeen + 1);
            return {
              phase: response.decision_valid ? 'ready' : 'warming',
              message: response.decision_valid
                ? `PC 分期 ${response.selected_stage ?? '分析中'}`
                : `PC 算法预热 ${Math.min(30, chunksSeen * 5)}/30s`,
              chunksSeen,
              lastResponse: response
            };
          });
        } catch (error) {
          remoteStagingSession.current = null;
          setSleepService({
            phase: 'fallback',
            message: 'PC 服务中断，已切换本地判定',
            chunksSeen: 0,
            lastResponse: null
          });
          console.warn('Sleep staging step failed', error);
        }
      });
    }
  }, []);

  const enqueueSleepDemoChunks = useCallback((chunks: SleepDemoStepRequest[]) => {
    for (const chunk of chunks) {
      sleepDemoStepQueue.current = sleepDemoStepQueue.current.then(async () => {
        const current = settingsRef.current.sleepMusic;
        const remoteState = remoteBlinkState.current;
        if (
          !current.serviceEnabled
          || !isTauriRuntime()
          || !remoteState
          || remoteState.sessionId !== chunk.session_id
        ) return;
        try {
          const response = await submitSleepDemoStep(current.serviceEndpoint, chunk);
          remoteBlinkState.current = {
            sessionId: chunk.session_id,
            enabled: response.state.blink_interaction_enabled
          };
          const calibrationReady = response.state.calibration_complete;
          const blinkStatus = response.state.blink_calibration_status;
          setSleepDemoService((previous) => ({
            ...previous,
            phase: calibrationReady ? 'ready' : 'calibrating',
            message: calibrationReady
              ? `Alpha 在线 · 眨眼${blinkStatus === 'complete' ? '就绪' : blinkStatus === 'running' ? '校准中' : '待校准'}`
              : 'Alpha 个体基线校准中',
            lastResponse: response
          }));
          setBlinkSnapshot((previous) => blinkSnapshotFromResponse(response, previous));
        } catch (error) {
          remoteBlinkState.current = null;
          setSleepDemoService((previous) => ({
            ...previous,
            phase: 'fallback',
            message: 'v1.2 Demo 流中断，已使用本地检测',
            lastResponse: null
          }));
          console.warn('Sleep demo signal step failed', error);
        }
      });
    }
  }, []);

  const flushSamples = useCallback((events: SampleEvent[]) => {
    if (events.length === 0) return;
    enqueueSleepChunks(sleepAssembler.current.pushMany(events));
    enqueueSleepDemoChunks(sleepDemoAssembler.current.pushMany(events));
    setBuffers((current) => mergeSampleEvents(current, events));
    setSampleCount((count) => count + events.length);
  }, [enqueueSleepChunks, enqueueSleepDemoChunks]);

  useEffect(() => {
    sampleBatcher.current = new SampleBatcher({
      intervalMs: SAMPLE_FLUSH_INTERVAL_MS,
      onFlush: flushSamples
    });
    return () => {
      sampleBatcher.current?.flush();
      sampleBatcher.current?.dispose();
      sampleBatcher.current = null;
    };
  }, [flushSamples]);

  const pushSample = useCallback((event: SampleEvent) => {
    const batcher = sampleBatcher.current;
    if (batcher) {
      batcher.push(event);
      return;
    }
    flushSamples([event]);
  }, [flushSamples]);

  // 演示模式：开启后以 100Hz 速率注入模拟样本，无需真实设备即可驱动波形/饼图/仪表
  useEffect(() => {
    if (!settings.demoMode) return;
    setStatus('演示模式：模拟数据流入');
    const intervalMs = 50;
    const perTick = Math.max(1, Math.round((intervalMs / 1000) * DEMO_SAMPLE_RATE));
    const timer = window.setInterval(() => {
      const events = createDemoSamples(perTick);
      flushSamples(events);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [flushSamples, settings.demoMode]);

  // 预热倒计时：连接后等待电极稳定，期间提示用户
  const startWarmup = useCallback(() => {
    const seconds = Number(settings.warmupDelaySeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setWarmupRemaining(seconds);
  }, [settings.warmupDelaySeconds]);

  useEffect(() => {
    if (warmupRemaining <= 0) return;
    const timer = window.setTimeout(() => setWarmupRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [warmupRemaining]);

  // 自动重连：仅在开启 autoReconnect 且有上次连接的设备时触发
  const reconnectTimer = useRef<number | undefined>(undefined);
  const handleUnexpectedDisconnect = useCallback(() => {
    if (!settings.autoReconnect) return;
    const deviceId = lastConnectedDevice.current;
    if (!deviceId) return;
    if (reconnectTimer.current) return;
    const attempt = ++reconnectAttempt.current;
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
    setStatus(`将在 ${Math.round(delay / 1000)}s 后自动重连 (第 ${attempt} 次)`);
    reconnectTimer.current = window.setTimeout(async () => {
      reconnectTimer.current = undefined;
      try {
        setStatus('正在自动重连设备');
        await invokeCommand('connect_device', { deviceId });
        setConnected(true);
        reconnectAttempt.current = 0;
        setStatus('设备已重新连接');
        startWarmup();
      } catch (error) {
        setStatus(`自动重连失败: ${error}`);
        handleUnexpectedDisconnect();
      }
    }, delay);
  }, [settings.autoReconnect, startWarmup]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    listen<SampleEvent>('ble://sample', (event) => {
      if (!cancelled) pushSample(event.payload);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    listen<StatusEvent>('ble://status', (event) => {
      if (cancelled) return;
      setConnected(event.payload.connected);
      setStatus(event.payload.message);
      if (!event.payload.connected) {
        handleUnexpectedDisconnect();
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [pushSample, handleUnexpectedDisconnect]);

  const visibleBuffers = useMemo(() => {
    const result: ChannelBuffers = { ...buffers };
    if (typeof settings.eeg.timeWindowSeconds !== 'number') return result;
    // 时间窗基准：取所有通道中最新的时间戳，避免绑定单一 EEG 通道
    let last = 0;
    for (const channel of allChannels) {
      const tail = buffers[channel][buffers[channel].length - 1]?.timestamp;
      if (tail && tail > last) last = tail;
    }
    if (!last) return result;
    const minTime = last - settings.eeg.timeWindowSeconds * 1000;
    for (const channel of allChannels) {
      result[channel] = buffers[channel].filter((item) => item.timestamp >= minTime);
    }
    return result;
  }, [buffers, settings.eeg.timeWindowSeconds]);

  const scanDevices = async () => {
    setScanning(true);
    setStatus('正在扫描 BLE 设备');
    try {
      const result = await invokeCommand<DeviceInfo[]>('scan_devices');
      setDevices(result);
      setStatus(`发现 ${result.length} 个设备`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setScanning(false);
    }
  };

  const connectDevice = async () => {
    if (!selectedDeviceId) return;
    try {
      setStatus('正在连接设备');
      await invokeCommand('connect_device', { deviceId: selectedDeviceId });
      lastConnectedDevice.current = selectedDeviceId;
      reconnectAttempt.current = 0;
      setConnected(true);
      setStatus('设备已连接');
      startWarmup();
    } catch (error) {
      setStatus(String(error));
    }
  };

  const disconnectDevice = async () => {
    try {
      // 用户主动断开时清除自动重连上下文
      lastConnectedDevice.current = '';
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
      }
      await invokeCommand('disconnect_device');
      setConnected(false);
      setStatus('已断开连接');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const sendCommand = async () => {
    try {
      await invokeCommand('send_command', { hex: commandText });
      setStatus('命令已发送');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const toggleRecording = async () => {
    try {
      if (recording) {
        await invokeCommand('stop_recording');
        setRecording(false);
        setStatus('记录已停止');
      } else {
        const path = await invokeCommand<string>('start_recording', { directory: settings.recordDir || null });
        setRecordPath(path);
        setRecording(true);
        setStatus('记录已开始');
      }
    } catch (error) {
      setStatus(String(error));
    }
  };

  const normalWaveforms = useMemo(() => {
    return allChannels
      .filter((channel) => settings.visibleChannels[channel])
      .map((channel) => ({
        channel,
        series: [
          {
            label: channelLabels[channel],
            color: channelColors[channel],
            values: applyNormalFilters(visibleBuffers[channel], channel, settings)
          }
        ]
      }));
  }, [visibleBuffers, settings]);

  const handleSelectSleepTrack = useCallback((trackId: string) => {
    setSettings((current) => ({
      ...current,
      sleepMusic: {
        ...current.sleepMusic,
        selectedTrackId: trackId,
        recentTrackIds: [
          trackId,
          ...current.sleepMusic.recentTrackIds.filter((item) => item !== trackId)
        ].slice(0, 12)
      }
    }));
  }, []);

  const handleImportSleepTracks = useCallback(async (): Promise<number> => {
    const picked = await pickAudioTracks();
    if (picked.length === 0) return 0;
    setSettings((current) => ({
      ...current,
      sleepMusic: {
        ...current.sleepMusic,
        libraryTracks: mergeAudioTracks(current.sleepMusic.libraryTracks, picked)
      }
    }));
    return picked.length;
  }, []);

  const handleRemoveSleepTrack = useCallback((trackId: string) => {
    setSettings((current) => {
      const tracks = current.sleepMusic.tracks.filter((track) => track.id !== trackId);
      const selectedTrackId = current.sleepMusic.selectedTrackId === trackId
        ? tracks[0]?.id ?? null
        : current.sleepMusic.selectedTrackId;
      return {
        ...current,
        sleepMusic: { ...current.sleepMusic, tracks, selectedTrackId }
      };
    });
  }, []);

  const handleAddSleepTrack = useCallback((trackId: string) => {
    setSettings((current) => {
      if (current.sleepMusic.tracks.some((track) => track.id === trackId)) return current;
      const track = current.sleepMusic.libraryTracks.find((item) => item.id === trackId);
      if (!track) return current;
      return {
        ...current,
        sleepMusic: {
          ...current.sleepMusic,
          tracks: [...current.sleepMusic.tracks, track].slice(0, 24)
        }
      };
    });
  }, []);

  const handleDeleteSleepTrack = useCallback((trackId: string) => {
    setSettings((current) => {
      const removed = current.sleepMusic.libraryTracks.find((track) => track.id === trackId);
      if (!removed || removed.source === 'builtin') return current;
      revokeAudioTrack(removed);
      const libraryTracks = current.sleepMusic.libraryTracks.filter((track) => track.id !== trackId);
      const tracks = current.sleepMusic.tracks.filter((track) => track.id !== trackId);
      const selectedTrackId = current.sleepMusic.selectedTrackId === trackId
        ? tracks[0]?.id ?? null
        : current.sleepMusic.selectedTrackId;
      return {
        ...current,
        sleepMusic: {
          ...current.sleepMusic,
          libraryTracks,
          tracks,
          selectedTrackId,
          recentTrackIds: current.sleepMusic.recentTrackIds.filter((item) => item !== trackId)
        }
      };
    });
  }, []);

  const handleMoveSleepTrack = useCallback((trackId: string, direction: -1 | 1) => {
    setSettings((current) => {
      const tracks = [...current.sleepMusic.tracks];
      const index = tracks.findIndex((track) => track.id === trackId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= tracks.length) return current;
      [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
      return {
        ...current,
        sleepMusic: { ...current.sleepMusic, tracks }
      };
    });
  }, []);

  const handleAutoModeChange = useCallback((autoMode: boolean) => {
    setSettings((current) => ({
      ...current,
      sleepMusic: { ...current.sleepMusic, autoMode }
    }));
  }, []);

  const handleBaseVolumeChange = useCallback((baseVolume: number) => {
    setBlinkVolumeOffset(0);
    setSettings((current) => ({
      ...current,
      sleepMusic: { ...current.sleepMusic, baseVolume: clamp01(baseVolume) }
    }));
  }, []);

  const resetSleepSession = useCallback(() => {
    const sessionId = createSleepSessionId();
    sleepAssembler.current.reset(sessionId);
    sleepDemoAssembler.current.reset(sessionId);
    remoteStagingSession.current = null;
    remoteBlinkState.current = null;
    lastDemoGestureTimestamp.current = -1;
    lastAppliedDemoTimestamp.current = -1;
    setSleepSession(createSleepSessionState(toSleepSessionConfig(settingsRef.current)));
    setSleepMetrics(null);
    setBlinkVolumeOffset(0);
    blinkDetector.current.reset();
    setBlinkSnapshot(blinkDetector.current.snapshot());
    const sleep = settingsRef.current.sleepMusic;
    if (sleep.serviceEnabled && isTauriRuntime()) {
      setSleepService({
        phase: 'checking',
        message: '正在重置 PC 睡眠算法',
        chunksSeen: 0,
        lastResponse: null
      });
      setSleepDemoService((current) => ({
        ...current,
        phase: 'calibrating',
        message: '正在重置 Alpha / 眨眼基线',
        lastResponse: null
      }));
      sleepStepQueue.current = sleepStepQueue.current
        .then(async () => {
          await resetSleepStaging(sleep.serviceEndpoint, sessionId);
          remoteStagingSession.current = sessionId;
          setSleepService({
            phase: 'warming',
            message: 'PC 算法预热 0/30s',
            chunksSeen: 0,
            lastResponse: null
          });
        })
        .catch((error) => {
          remoteStagingSession.current = null;
          setSleepService({
            phase: 'fallback',
            message: 'PC 服务不可用，已切换本地判定',
            chunksSeen: 0,
            lastResponse: null
          });
          console.warn('Sleep staging reset failed', error);
        });
      sleepDemoStepQueue.current = sleepDemoStepQueue.current
        .then(async () => {
          const response = await resetSleepDemo(
            sleep.serviceEndpoint,
            sessionId,
            sleep.blinkControlEnabled
          );
          remoteBlinkState.current = {
            sessionId,
            enabled: sleep.blinkControlEnabled
          };
          setSleepDemoService((current) => ({
            ...current,
            phase: 'calibrating',
            message: 'Alpha 20s 校准中 · 眨眼待测量',
            lastResponse: response
          }));
        })
        .catch((error) => {
          remoteBlinkState.current = null;
          setSleepDemoService((current) => ({
            ...current,
            phase: 'fallback',
            message: 'v1.2 Demo 重置失败，已使用本地检测',
            lastResponse: null
          }));
          console.warn('Sleep demo signal reset failed', error);
        });
    }
  }, []);

  const handleOpenSleepAlgorithm = useCallback(async () => {
    try {
      setSleepRuntime(await openSleepStagingDirectory());
    } catch (error) {
      setSleepService((current) => ({
        ...current,
        phase: 'fallback',
        message: String(error)
      }));
    }
  }, []);

  const handleStartSleepService = useCallback(async () => {
    const sleep = settingsRef.current.sleepMusic;
    setSleepService((current) => ({
      ...current,
      phase: 'checking',
      message: '正在启动 PC 睡眠算法'
    }));
    try {
      const runtime = await startSleepStagingService(endpointPort(sleep.serviceEndpoint));
      setSleepRuntime(runtime);
      const health = await waitForSleepStagingHealth(sleep.serviceEndpoint);
      const sessionId = sleepAssembler.current.currentSessionId;
      const [, demoResponse] = await Promise.all([
        resetSleepStaging(sleep.serviceEndpoint, sessionId),
        resetSleepDemo(sleep.serviceEndpoint, sessionId, sleep.blinkControlEnabled)
      ]);
      remoteStagingSession.current = sessionId;
      remoteBlinkState.current = { sessionId, enabled: sleep.blinkControlEnabled };
      setSleepService({
        phase: 'warming',
        message: 'PC 算法预热 0/30s',
        chunksSeen: 0,
        lastResponse: null
      });
      setSleepDemoService({
        phase: 'calibrating',
        message: 'Alpha 20s 校准中 · 眨眼待测量',
        alphaCalibrationSeconds: health.demo?.calibration_seconds
          ?? DEFAULT_ALPHA_CALIBRATION_SECONDS,
        blinkCalibrationSeconds: health.demo?.blink_calibration_seconds
          ?? DEFAULT_BLINK_CALIBRATION_SECONDS,
        lastResponse: demoResponse
      });
    } catch (error) {
      remoteStagingSession.current = null;
      setSleepService({
        phase: 'fallback',
        message: String(error),
        chunksSeen: 0,
        lastResponse: null
      });
      remoteBlinkState.current = null;
      setSleepDemoService((current) => ({
        ...current,
        phase: 'fallback',
        message: 'v1.2 Demo 服务不可用',
        lastResponse: null
      }));
    }
  }, []);

  const handleStopSleepService = useCallback(async () => {
    try {
      setSleepRuntime(await stopSleepStagingService());
    } finally {
      remoteStagingSession.current = null;
      remoteBlinkState.current = null;
      setSleepService({
        phase: 'local',
        message: 'PC 服务已停止，使用本地判定',
        chunksSeen: 0,
        lastResponse: null
      });
      setSleepDemoService({
        phase: 'local',
        message: '本地 Alpha / 眨眼检测',
        alphaCalibrationSeconds: DEFAULT_ALPHA_CALIBRATION_SECONDS,
        blinkCalibrationSeconds: DEFAULT_BLINK_CALIBRATION_SECONDS,
        lastResponse: null
      });
    }
  }, []);

  const musicPlayer = useMusicPlayer({
    tracks: settings.sleepMusic.tracks,
    selectedTrackId: settings.sleepMusic.selectedTrackId,
    enabled: settings.sleepMusic.enabled,
    autoMode: settings.sleepMusic.autoMode,
    automationAction: sleepSession.action,
    targetVolume: clamp(
      sleepSession.targetVolume + blinkVolumeOffset,
      0,
      settings.sleepMusic.baseVolume
    ),
    stopFadeSeconds: settings.sleepMusic.stopFadeSeconds,
    onSelectTrack: handleSelectSleepTrack
  });

  useEffect(() => {
    setBlinkVolumeOffset((current) => {
      const applied = clamp(
        sleepSession.targetVolume + current,
        0,
        settings.sleepMusic.baseVolume
      );
      const synchronized = applied - sleepSession.targetVolume;
      return Math.abs(synchronized - current) < 1e-6 ? current : synchronized;
    });
  }, [settings.sleepMusic.baseVolume, sleepSession.targetVolume]);

  const handleOpenMusicLibrary = useCallback(() => {
    resumeAfterLibraryRef.current = musicPlayer.snapshot.playing;
    musicPlayer.pause();
    setMusicLibraryOpen(true);
  }, [musicPlayer.pause, musicPlayer.snapshot.playing]);

  const handleCloseMusicLibrary = useCallback(() => {
    const shouldResume = resumeAfterLibraryRef.current;
    resumeAfterLibraryRef.current = false;
    setMusicLibraryOpen(false);
    if (shouldResume && musicPlayer.selectedTrack) void musicPlayer.play();
  }, [musicPlayer.play, musicPlayer.selectedTrack]);

  const handleSleepMetrics = useCallback((metrics: SleepMetrics) => {
    setSleepMetrics((current) => sleepMetricsEqual(current, metrics) ? current : metrics);
  }, []);

  const onlineDemoSignal = settings.sleepMusic.serviceEnabled
    && (sleepDemoService.phase === 'calibrating' || sleepDemoService.phase === 'ready')
    ? sleepDemoService.lastResponse
    : null;

  useEffect(() => {
    if ((!sleepMetrics && !onlineDemoSignal) || !settings.sleepMusic.enabled) return;
    const values = buffers[settings.eeg.selectedChannel];
    const quality = estimateSignalQuality(values);
    const demoPhase = settings.demoMode ? settings.sleepMusic.demoPhase : 'live';
    if (values.length < 40 && demoPhase === 'live' && !onlineDemoSignal) return;
    const service = settings.sleepMusic.serviceEnabled
      && (sleepService.phase === 'warming' || sleepService.phase === 'ready')
      && sleepService.lastResponse
      ? toServiceObservation(sleepService.lastResponse)
      : null;
    const demoSignal = onlineDemoSignal
      ? onlineDemoSignal.timestamp_ms > lastAppliedDemoTimestamp.current
        ? onlineDemoSignal
        : { ...onlineDemoSignal, action_flags: [] }
      : null;
    if (onlineDemoSignal && onlineDemoSignal.timestamp_ms > lastAppliedDemoTimestamp.current) {
      lastAppliedDemoTimestamp.current = onlineDemoSignal.timestamp_ms;
    }

    setSleepSession((current) => advanceSleepSession(current, {
      timestampMs: Date.now(),
      signalValid: quality.valid,
      coverage: quality.coverage,
      alphaRelative: sleepMetrics?.alphaRelative
        ?? onlineDemoSignal?.telemetry.alpha_ratio
        ?? 0,
      sleepScore: sleepMetrics?.sleepOnsetScore ?? 0,
      demoPhase,
      service,
      demoSignal
    }, sleepConfig));
  }, [
    buffers,
    settings.demoMode,
    settings.eeg.selectedChannel,
    settings.sleepMusic.demoPhase,
    settings.sleepMusic.enabled,
    settings.sleepMusic.serviceEnabled,
    sleepConfig,
    sleepMetrics,
    onlineDemoSignal,
    sleepService
  ]);

  const usingOnlineDemoDetector = onlineDemoSignal !== null;

  useEffect(() => {
    const remoteState = remoteBlinkState.current;
    if (
      !settings.sleepMusic.serviceEnabled
      || !isTauriRuntime()
      || !remoteState
      || remoteState.enabled === settings.sleepMusic.blinkControlEnabled
    ) return;
    const enabled = settings.sleepMusic.blinkControlEnabled;
    const sessionId = remoteState.sessionId;
    sleepDemoStepQueue.current = sleepDemoStepQueue.current
      .then(async () => {
        const response = await setSleepDemoBlinkEnabled(
          settingsRef.current.sleepMusic.serviceEndpoint,
          sessionId,
          enabled
        );
        remoteBlinkState.current = { sessionId, enabled };
        setSleepDemoService((current) => ({ ...current, lastResponse: response }));
      })
      .catch((error) => {
        remoteBlinkState.current = null;
        setSleepDemoService((current) => ({
          ...current,
          phase: 'fallback',
          message: '眨眼开关同步失败，已使用本地检测',
          lastResponse: null
        }));
        console.warn('Sleep demo blink toggle failed', error);
      });
  }, [
    settings.sleepMusic.blinkControlEnabled,
    settings.sleepMusic.serviceEnabled,
    sleepDemoService.phase
  ]);

  useEffect(() => {
    const remoteState = remoteBlinkState.current;
    if (!settings.sleepMusic.serviceEnabled || !isTauriRuntime() || !remoteState) return;
    const sessionActive = sleepSession.phase !== 'ready' && sleepSession.phase !== 'signal-poor';
    sleepDemoStepQueue.current = sleepDemoStepQueue.current
      .then(async () => {
        const response = await configureSleepDemo(
          settingsRef.current.sleepMusic.serviceEndpoint,
          remoteState.sessionId,
          settingsRef.current.sleepMusic.alphaVolumeMode,
          sessionActive
        );
        setSleepDemoService((current) => ({ ...current, lastResponse: response }));
      })
      .catch((error) => console.warn('Sleep demo configuration sync failed', error));
  }, [
    settings.sleepMusic.alphaVolumeMode,
    settings.sleepMusic.serviceEnabled,
    sleepSession.phase
  ]);

  const handleBlinkCalibration = useCallback(() => {
    const remoteState = remoteBlinkState.current;
    if (settingsRef.current.sleepMusic.serviceEnabled && isTauriRuntime() && remoteState) {
      setSleepDemoService((current) => ({
        ...current,
        message: '眨眼测量进行中：先 3 秒睁眼安静不眨眼，再每 0.5-1 秒自然眨眼 10 秒'
      }));
      sleepDemoStepQueue.current = sleepDemoStepQueue.current
        .then(async () => {
          const response = await startSleepDemoBlinkCalibration(
            settingsRef.current.sleepMusic.serviceEndpoint,
            remoteState.sessionId,
            true
          );
          setSleepDemoService((current) => ({ ...current, lastResponse: response }));
          setBlinkSnapshot((previous) => blinkSnapshotFromResponse(response, previous));
        })
        .catch((error) => {
          const startedAt = Date.now();
          lastBlinkSampleTimestamp.current = startedAt;
          setBlinkSnapshot(blinkDetector.current.beginCalibration(startedAt));
          setSleepDemoService((current) => ({
            ...current,
            phase: 'fallback',
            message: '服务校准启动失败，已切换本地双通道测量',
            lastResponse: null
          }));
          console.warn('Sleep demo blink calibration failed', error);
        });
      return;
    }

    const startedAt = Date.now();
    lastBlinkSampleTimestamp.current = startedAt;
    setBlinkSnapshot(blinkDetector.current.beginCalibration(startedAt));
  }, []);

  useEffect(() => {
    if (usingOnlineDemoDetector) return;
    blinkDetector.current.reset();
    lastBlinkSampleTimestamp.current = 0;
    setBlinkSnapshot(blinkDetector.current.snapshot());
  }, [usingOnlineDemoDetector]);

  useEffect(() => {
    if (usingOnlineDemoDetector) return;
    const localState = blinkDetector.current.snapshot();
    if (!settings.sleepMusic.blinkControlEnabled && localState.calibrationStatus !== 'running') return;
    const eeg1 = buffers.eeg1;
    const eeg2ByTime = new Map(buffers.eeg2.map((point) => [point.timestamp, point.value]));
    const eeg3ByTime = new Map(buffers.eeg3.map((point) => [point.timestamp, point.value]));
    const eeg4ByTime = new Map(buffers.eeg4.map((point) => [point.timestamp, point.value]));
    const accXByTime = new Map(buffers.accX.map((point) => [point.timestamp, point.value]));
    const accYByTime = new Map(buffers.accY.map((point) => [point.timestamp, point.value]));
    const accZByTime = new Map(buffers.accZ.map((point) => [point.timestamp, point.value]));
    let newestTimestamp = lastBlinkSampleTimestamp.current;
    for (const point of eeg1) {
      if (point.timestamp <= lastBlinkSampleTimestamp.current) continue;
      const eeg2 = eeg2ByTime.get(point.timestamp);
      const eeg3 = eeg3ByTime.get(point.timestamp);
      const eeg4 = eeg4ByTime.get(point.timestamp);
      if (eeg2 === undefined || eeg3 === undefined || eeg4 === undefined) continue;
      const accX = accXByTime.get(point.timestamp) ?? 0;
      const accY = accYByTime.get(point.timestamp) ?? 0;
      const accZ = accZByTime.get(point.timestamp) ?? 0;
      const motion = Math.sqrt(accX * accX + accY * accY + accZ * accZ);
      blinkDetector.current.push(
        [signedU24(point.value), signedU24(eeg2), signedU24(eeg3), signedU24(eeg4)],
        point.timestamp,
        true,
        motion
      );
      newestTimestamp = Math.max(newestTimestamp, point.timestamp);
    }
    lastBlinkSampleTimestamp.current = newestTimestamp;
    setBlinkSnapshot(blinkDetector.current.snapshot(Date.now()));
  }, [
    buffers,
    settings.sleepMusic.blinkControlEnabled,
    usingOnlineDemoDetector
  ]);

  useEffect(() => {
    if (!settings.sleepMusic.blinkControlEnabled || usingOnlineDemoDetector) return;
    const timer = window.setInterval(() => {
      const gesture = blinkDetector.current.poll(Date.now());
      setBlinkSnapshot(blinkDetector.current.snapshot(Date.now()));
      if (!gesture) return;
      const current = settingsRef.current.sleepMusic;
      const direction = gesture === 'volume-down' ? -1 : 1;
      const nextVolume = clamp(
        musicPlayer.snapshot.volume + direction * current.blinkVolumeStep,
        0,
        current.baseVolume
      );
      setBlinkVolumeOffset(nextVolume - sleepSession.targetVolume);
      musicPlayer.setVolume(nextVolume);
    }, 200);
    return () => window.clearInterval(timer);
  }, [
    musicPlayer.setVolume,
    musicPlayer.snapshot.volume,
    settings.sleepMusic.blinkControlEnabled,
    sleepSession.targetVolume,
    usingOnlineDemoDetector
  ]);

  useEffect(() => {
    if (!onlineDemoSignal || onlineDemoSignal.timestamp_ms <= lastDemoGestureTimestamp.current) return;
    lastDemoGestureTimestamp.current = onlineDemoSignal.timestamp_ms;
    const down = onlineDemoSignal.action_flags.includes('VOLUME_DOWN_3_BLINKS');
    const up = onlineDemoSignal.action_flags.includes('VOLUME_UP_5_BLINKS');
    if (!down && !up) return;
    const current = settingsRef.current.sleepMusic;
    const nextVolume = clamp(
      musicPlayer.snapshot.volume + (down ? -1 : 1) * current.blinkVolumeStep,
      0,
      current.baseVolume
    );
    setBlinkVolumeOffset(nextVolume - sleepSession.targetVolume);
    musicPlayer.setVolume(nextVolume);
  }, [
    musicPlayer.setVolume,
    musicPlayer.snapshot.volume,
    onlineDemoSignal,
    sleepSession.targetVolume
  ]);

  useEffect(() => {
    if (
      sleepSession.reason !== 'service-stop-music'
      || !settings.sleepMusic.blinkControlEnabled
    ) return;
    setSettings((current) => ({
      ...current,
      sleepMusic: { ...current.sleepMusic, blinkControlEnabled: false }
    }));
  }, [settings.sleepMusic.blinkControlEnabled, sleepSession.reason]);

  const musicPanel = {
    session: sleepSession,
    settings: settings.sleepMusic,
    player: musicPlayer,
    blink: blinkSnapshot,
    serviceStatus: {
      phase: sleepService.phase,
      message: sleepService.message,
      chunksSeen: sleepService.chunksSeen
    },
    demoSignalStatus: sleepDemoService,
    onSelectTrack: handleSelectSleepTrack,
    onOpenLibrary: handleOpenMusicLibrary,
    onRemoveTrack: handleRemoveSleepTrack,
    onAutoModeChange: handleAutoModeChange,
    onVolumeChange: handleBaseVolumeChange,
    onBlinkCalibration: handleBlinkCalibration,
    onResetSession: resetSleepSession
  };

  const density = resolveViewportDensity(viewport.height);
  const settingsPanelWidth = resolveSettingsPanelWidth(viewport.width);
  const appStyle: AppStyle = {
    '--normal-columns': resolveNormalGridColumns(viewport.width, settingsOpen),
    '--settings-panel-width': `${settingsPanelWidth}px`,
    '--settings-form-columns': resolveSettingsFormColumns(settingsPanelWidth),
    '--share-list-columns': resolveEegShareListColumns(viewport.width, settingsOpen)
  };
  const musicLibrary = (
    <MusicLibraryModal
      open={musicLibraryOpen}
      libraryTracks={settings.sleepMusic.libraryTracks}
      playlistTracks={settings.sleepMusic.tracks}
      recentTrackIds={settings.sleepMusic.recentTrackIds}
      selectedTrackId={settings.sleepMusic.selectedTrackId}
      onClose={handleCloseMusicLibrary}
      onImportTracks={handleImportSleepTracks}
      onAddToPlaylist={handleAddSleepTrack}
      onRemoveFromPlaylist={handleRemoveSleepTrack}
      onSelectTrack={handleSelectSleepTrack}
      onDeleteTrack={handleDeleteSleepTrack}
      onMoveTrack={handleMoveSleepTrack}
    />
  );

  if (settings.showChartsOnly) {
    return (
      <main className="app-shell pure-shell" data-theme={settings.theme} data-density={density} style={appStyle}>
        <PureWaveformView
          values={visibleBuffers[settings.eeg.selectedChannel]}
          settings={settings}
          onChange={setSettings}
          onExit={() => setSettings((value) => ({ ...value, showChartsOnly: false }))}
          onToggleFullscreen={toggleFullscreen}
          connected={connected}
          status={status}
          sampleCount={sampleCount}
          warmupRemaining={warmupRemaining}
          onSleepMetrics={handleSleepMetrics}
          musicPanel={musicPanel}
        />
        {musicLibrary}
      </main>
    );
  }

  return (
    <main className="app-shell" data-theme={settings.theme} data-density={density} style={appStyle}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Activity size={22} />
          </span>
          <div className="brand-text">
            <h1>iFET EEG Client</h1>
            <span className="status-chip">
              {sampleCount} samples
              {warmupRemaining > 0 && <em>· 预热 {warmupRemaining}s</em>}
            </span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="theme-switcher">
            <Palette size={17} />
            <span>主题</span>
            <ThemedSelect
              ariaLabel="界面主题"
              value={settings.theme}
              options={themeOptions}
              onChange={(theme) => setSettings((value) => ({ ...value, theme: theme as ThemeName }))}
            />
          </div>
          <button
            className="icon-button"
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Settings2 size={18} />
            <span>设置</span>
          </button>
        </div>
      </header>

      {!settings.showChartsOnly && (
        <DevicePanel
          devices={devices}
          connected={connected}
          scanning={scanning}
          recording={recording}
          selectedDeviceId={selectedDeviceId}
          commandText={commandText}
          status={status}
          recordPath={recordPath}
          onCommandTextChange={setCommandText}
          onSelectedDeviceChange={setSelectedDeviceId}
          onScan={scanDevices}
          onConnect={connectDevice}
          onDisconnect={disconnectDevice}
          onSend={sendCommand}
          onToggleRecording={toggleRecording}
        />
      )}

      <div className={settingsOpen ? 'workspace with-settings' : 'workspace'}>
        <section className="waveform-area">
          {settings.displayMode === 'eeg' ? (
            <EegModeView
              channel={settings.eeg.selectedChannel}
              values={visibleBuffers[settings.eeg.selectedChannel]}
              settings={settings.eeg}
              onSleepMetrics={handleSleepMetrics}
              musicPanel={musicPanel}
            />
          ) : (
            <div className="normal-grid">
              {normalWaveforms.map((item) => (
                <WaveformCanvas key={item.channel} title={`${channelLabels[item.channel]} 波形`} series={item.series} fill />
              ))}
            </div>
          )}
        </section>
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            sleepServiceStatus={{
              phase: sleepService.phase,
              message: sleepService.message,
              chunksSeen: sleepService.chunksSeen
            }}
            sleepDemoStatus={{
              phase: sleepDemoService.phase,
              message: sleepDemoService.message,
              lastResponse: sleepDemoService.lastResponse
            }}
            sleepRuntime={sleepRuntime}
            blinkStatus={blinkSnapshot}
            onOpenSleepAlgorithm={() => void handleOpenSleepAlgorithm()}
            onStartSleepService={() => void handleStartSleepService()}
            onStopSleepService={() => void handleStopSleepService()}
            onBlinkCalibration={handleBlinkCalibration}
            onOpenMusicLibrary={handleOpenMusicLibrary}
          />
        )}
      </div>
      {musicLibrary}
    </main>
  );
}

function getViewportSize() {
  if (typeof window === 'undefined') {
    return { width: 1440, height: 920 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

// 默认采样率（协议未携带，与 EEG 保持一致）
const DEFAULT_SAMPLE_RATE = 100;

// 普通模式滤波（带通/卡尔曼）是状态ful的，必须与 EEG 频带一样走增量缓存：
// 每次 flush 只处理新样本，避免整窗重复喂给滤波器造成波形失真。
const normalFilterCaches = new Map<ChannelKey, StreamingFilterCache>();

function getNormalFilterCache(channel: ChannelKey): StreamingFilterCache {
  let cache = normalFilterCaches.get(channel);
  if (!cache) {
    cache = new StreamingFilterCache();
    normalFilterCaches.set(channel, cache);
  }
  return cache;
}

function applyNormalFilters(
  values: TimedValue[],
  channel: ChannelKey,
  settings: AppSettings
): TimedValue[] {
  const bandpassOn = settings.filterEnabled && settings.filterHigh > settings.filterLow;
  const kalmanOn = settings.kalmanEnabled;
  const cache = getNormalFilterCache(channel);
  if (!bandpassOn && !kalmanOn) {
    // 滤波全关时清空缓存：否则下次再开时，关闭期间的样本永远不会被处理，输出出现断档
    cache.reset();
    return values;
  }
  const key = [
    channel,
    bandpassOn ? `${settings.filterLow}-${settings.filterHigh}` : 'off',
    kalmanOn ? `${settings.kalmanQ}|${settings.kalmanR}` : 'off'
  ].join('|');
  return cache.update(key, values, () => {
    const chain = bandpassOn
      ? FilterChain.firBandpass({
        low: settings.filterLow,
        high: settings.filterHigh,
        sampleRate: DEFAULT_SAMPLE_RATE
      })
      : null;
    const kalman = kalmanOn ? new KalmanFilter(settings.kalmanQ, settings.kalmanR) : null;
    return {
      process(input: number): number {
        let value = input;
        if (chain) value = chain.process(value);
        if (kalman) value = kalman.process(value);
        return value;
      },
      reset(): void {
        chain?.reset();
        kalman?.reset();
      }
    };
  });
}

async function toggleFullscreen(): Promise<void> {
  if (isTauriRuntime()) {
    const appWindow = getCurrentWindow();
    const fullscreen = await appWindow.isFullscreen();
    await appWindow.setFullscreen(!fullscreen);
    return;
  }

  if (document.fullscreenElement) {
    await document.exitFullscreen?.();
  } else {
    await document.documentElement.requestFullscreen?.();
  }
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    if (command === 'scan_devices') {
      return [{ id: 'preview-device', name: 'Preview BLE', rssi: -42 }] as T;
    }
    if (command === 'start_recording') {
      return '浏览器预览模式' as T;
    }
    return undefined as T;
  }
  return invoke<T>(command, args);
}

function toSleepSessionConfig(settings: AppSettings): SleepSessionConfig {
  const sleep = settings.sleepMusic;
  return {
    baseVolume: sleep.baseVolume,
    transitionVolume: sleep.transitionVolume,
    relaxAlphaThreshold: sleep.relaxAlphaThreshold,
    fadeSleepScoreThreshold: sleep.fadeSleepScoreThreshold,
    stopSleepScoreThreshold: sleep.stopSleepScoreThreshold,
    relaxConfirmSeconds: sleep.relaxConfirmSeconds,
    transitionConfirmSeconds: sleep.transitionConfirmSeconds,
    sleepConfirmSeconds: sleep.sleepConfirmSeconds,
    awakeConfirmSeconds: sleep.awakeConfirmSeconds,
    emaAlpha: sleep.emaAlpha,
    minimumCoverage: sleep.minimumCoverage
  };
}

function estimateSignalQuality(values: TimedValue[]): { coverage: number; valid: boolean } {
  if (values.length < 2) return { coverage: 0, valid: false };
  const lastTimestamp = values[values.length - 1].timestamp;
  const recent = values.filter((point) => point.timestamp >= lastTimestamp - 5_000);
  if (recent.length < 2) return { coverage: 0, valid: false };

  const spanMs = Math.max(10, recent[recent.length - 1].timestamp - recent[0].timestamp);
  const expectedSamples = Math.max(1, Math.round(spanMs / 10) + 1);
  const coverage = clamp01(recent.length / expectedSamples);
  let maximumGapMs = 0;
  for (let index = 1; index < recent.length; index += 1) {
    maximumGapMs = Math.max(maximumGapMs, recent[index].timestamp - recent[index - 1].timestamp);
  }
  return {
    coverage,
    valid: recent.length >= 40 && coverage >= 0.6 && maximumGapMs <= 2_000
  };
}

function sleepMetricsEqual(current: SleepMetrics | null, next: SleepMetrics): boolean {
  if (!current) return false;
  return current.alphaRelative === next.alphaRelative
    && current.thetaRelative === next.thetaRelative
    && current.betaRelative === next.betaRelative
    && current.sleepOnsetScore === next.sleepOnsetScore
    && current.solTrend === next.solTrend
    && current.n2Candidate === next.n2Candidate;
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

function createSleepSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ifet-${crypto.randomUUID()}`;
  }
  return `ifet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function endpointPort(endpoint: string): number {
  try {
    const url = new URL(endpoint);
    const port = Number(url.port || 80);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8765;
  } catch {
    return 8765;
  }
}

async function waitForSleepStagingHealth(endpoint: string): Promise<SleepStagingHealth> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await getSleepStagingHealth(endpoint);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error('Sleep staging service did not become ready');
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
