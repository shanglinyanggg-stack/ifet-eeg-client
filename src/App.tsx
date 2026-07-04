import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Activity, Palette, Settings2 } from 'lucide-react';
import { appendSample, type TimedValue } from './domain/dsp';
import { defaultSettings, loadSettings, saveSettings, themeOptions, type ThemeName } from './domain/settings';
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
import { WaveformCanvas } from './components/WaveformCanvas';

const MAX_POINTS = 1200;
const allChannels = Object.keys(channelLabels) as ChannelKey[];

type ChannelBuffers = Record<ChannelKey, TimedValue[]>;

function createEmptyBuffers(): ChannelBuffers {
  return allChannels.reduce((acc, channel) => {
    acc[channel] = [];
    return acc;
  }, {} as ChannelBuffers);
}

export default function App() {
  const [settings, setSettings] = useState(defaultSettings);
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

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlistenSample: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    listen<SampleEvent>('ble://sample', (event) => {
      pushSample(event.payload);
    }).then((unlisten) => {
      unlistenSample = unlisten;
    });

    listen<StatusEvent>('ble://status', (event) => {
      setConnected(event.payload.connected);
      setStatus(event.payload.message);
    }).then((unlisten) => {
      unlistenStatus = unlisten;
    });

    return () => {
      unlistenSample?.();
      unlistenStatus?.();
    };
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

  const visibleBuffers = useMemo(() => {
    const result: ChannelBuffers = { ...buffers };
    if (typeof settings.eeg.timeWindowSeconds !== 'number') return result;
    const selected = buffers[settings.eeg.selectedChannel];
    const last = selected[selected.length - 1]?.timestamp;
    if (!last) return result;
    const minTime = last - settings.eeg.timeWindowSeconds * 1000;
    for (const channel of allChannels) {
      result[channel] = buffers[channel].filter((item) => item.timestamp >= minTime);
    }
    return result;
  }, [buffers, settings.eeg.selectedChannel, settings.eeg.timeWindowSeconds]);

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
      setConnected(true);
      setStatus('设备已连接');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const disconnectDevice = async () => {
    try {
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

  const normalWaveforms = allChannels
    .filter((channel) => settings.visibleChannels[channel])
    .map((channel) => ({
      channel,
      series: [
        {
          label: channelLabels[channel],
          color: channelColors[channel],
          values: visibleBuffers[channel]
        }
      ]
    }));

  return (
    <main className="app-shell" data-theme={settings.theme}>
      <header className="topbar">
        <div className="brand">
          <Activity size={24} />
          <div>
            <h1>iFET EEG Client</h1>
            <span>{sampleCount} samples</span>
          </div>
        </div>
        <div className="topbar-actions">
          <label className="theme-switcher">
            <Palette size={17} />
            <span>主题</span>
            <select
              aria-label="界面主题"
              value={settings.theme}
              onChange={(event) => setSettings((value) => ({ ...value, theme: event.target.value as ThemeName }))}
            >
              {themeOptions.map((theme) => (
                <option key={theme.value} value={theme.value}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>
          <button className="icon-button" type="button" onClick={() => setSettingsOpen((value) => !value)}>
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
                <WaveformCanvas key={item.channel} title={`${channelLabels[item.channel]} 波形`} series={item.series} />
              ))}
            </div>
          )}
        </section>
        {settingsOpen && <SettingsPanel settings={settings} onChange={setSettings} />}
      </div>
    </main>
  );
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
