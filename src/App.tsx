import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Activity, Palette, Settings2 } from 'lucide-react';
import { appendSample, Biquad, FilterChain, KalmanRegistry, type TimedValue } from './domain/dsp';
import {
  resolveEegShareListColumns,
  resolveNormalGridColumns,
  resolveSettingsFormColumns,
  resolveSettingsPanelWidth,
  resolveViewportDensity
} from './domain/layout';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  themeOptions,
  type AppSettings,
  type ThemeName
} from './domain/settings';
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
import { SettingsPanel } from './components/SettingsPanel';
import { ThemedSelect } from './components/ThemedSelect';
import { WaveformCanvas } from './components/WaveformCanvas';

const MAX_POINTS = 1200;
const allChannels = Object.keys(channelLabels) as ChannelKey[];

type ChannelBuffers = Record<ChannelKey, TimedValue[]>;
type AppStyle = CSSProperties & {
  '--normal-columns': number;
  '--settings-panel-width': string;
  '--settings-form-columns': number;
  '--share-list-columns': number;
};

function createEmptyBuffers(): ChannelBuffers {
  return allChannels.reduce((acc, channel) => {
    acc[channel] = [];
    return acc;
  }, {} as ChannelBuffers);
}

export default function App() {
  const [settings, setSettings] = useState(defaultSettings);
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
  const [sampleCount, setSampleCount] = useState(0);
  const [warmupRemaining, setWarmupRemaining] = useState(0);
  const lastConnectedDevice = useRef('');
  const reconnectAttempt = useRef(0);

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const handleResize = () => setViewport(getViewportSize());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key !== 'F11') return;
      event.preventDefault();
      await toggleFullscreen();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const pushSample = useCallback((event: SampleEvent) => {
    const timestamp = Date.parse(event.timestamp) || Date.now();
    setBuffers((current) => {
      const next: ChannelBuffers = { ...current };
      const ppg = event.packet.ppg;
      const eeg = event.packet.eeg;
      const values: Partial<Record<ChannelKey, number>> = {
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
      for (const [channel, value] of Object.entries(values) as [ChannelKey, number | undefined][]) {
        if (typeof value === 'number') {
          next[channel] = appendSample(current[channel], { timestamp, value }, MAX_POINTS);
        }
      }
      return next;
    });
    setSampleCount((count) => count + 1);
  }, []);

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
      } catch (error) {
        setStatus(`自动重连失败: ${error}`);
        handleUnexpectedDisconnect();
      }
    }, delay);
  }, [settings.autoReconnect]);

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

  const density = resolveViewportDensity(viewport.height);
  const settingsPanelWidth = resolveSettingsPanelWidth(viewport.width);
  const appStyle: AppStyle = {
    '--normal-columns': resolveNormalGridColumns(viewport.width, settingsOpen),
    '--settings-panel-width': `${settingsPanelWidth}px`,
    '--settings-form-columns': resolveSettingsFormColumns(settingsPanelWidth),
    '--share-list-columns': resolveEegShareListColumns(viewport.width, settingsOpen)
  };

  return (
    <main className="app-shell" data-theme={settings.theme} data-density={density} style={appStyle}>
      <header className="topbar">
        <div className="brand">
          <Activity size={24} />
          <div>
            <h1>iFET EEG Client</h1>
            <span>
              {sampleCount} samples
              {warmupRemaining > 0 && ` · 预热 ${warmupRemaining}s`}
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
            />
          ) : (
            <div className="normal-grid">
              {normalWaveforms.map((item) => (
                <WaveformCanvas key={item.channel} title={`${channelLabels[item.channel]} 波形`} series={item.series} fill />
              ))}
            </div>
          )}
        </section>
        {settingsOpen && <SettingsPanel settings={settings} onChange={setSettings} />}
      </div>
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

// 为每个 normal 通道维护一条带通滤波链，跨渲染保持状态。
// 通过模块级 Registry 缓存，key 由通道+设置组成。
class FilterChainRegistry {
  private entries = new Map<string, FilterChain>();

  get(channel: ChannelKey, settings: AppSettings): FilterChain | null {
    const key = `${channel}|${settings.filterEnabled}|${settings.filterLow}|${settings.filterHigh}`;
    const existing = this.entries.get(key);
    if (existing) return existing;

    if (!settings.filterEnabled || settings.filterHigh <= settings.filterLow) {
      return null;
    }
    const chain = new FilterChain([Biquad.bandpass(settings.filterLow, settings.filterHigh, DEFAULT_SAMPLE_RATE)]);
    this.entries.set(key, chain);
    return chain;
  }
}

const normalFilterRegistry = new FilterChainRegistry();
const normalKalmanRegistry = new KalmanRegistry();

function applyNormalFilters(
  values: TimedValue[],
  channel: ChannelKey,
  settings: AppSettings
): TimedValue[] {
  const chain = normalFilterRegistry.get(channel, settings);
  const kalman = settings.kalmanEnabled
    ? normalKalmanRegistry.get(channel, settings.kalmanQ, settings.kalmanR)
    : null;
  if (!chain && !kalman) return values;
  return values.map((point) => {
    let value = point.value;
    if (chain) value = chain.process(value);
    if (kalman) value = kalman.process(value);
    return { timestamp: point.timestamp, value };
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

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
