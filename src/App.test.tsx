import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App, { extractChannelValues } from './App';
import { defaultSettings } from './domain/settings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve([]))
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined))
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isFullscreen: vi.fn(() => Promise.resolve(false)),
    setFullscreen: vi.fn(() => Promise.resolve())
  }))
}));

vi.mock('./components/WaveformCanvas', () => ({
  WaveformCanvas: ({ title }: { title: string }) => <section aria-label={title} data-testid="waveform" />
}));

const STORAGE_KEY = 'ifet-eeg-client-settings';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('App settings bootstrapping', () => {
  test('retains guidance, external synchronization, calibration and recording across workspaces',async()=>{
    render(<App/>);
    fireEvent.click(screen.getByRole('button',{name:'助眠引导',exact:true}));
    expect(await screen.findByLabelText('助眠控制与基线')).toBeInTheDocument();
    expect(screen.getByLabelText('睡眠音乐引导')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'实验同步',exact:true}));
    expect(await screen.findByText('MATLAB 刺激事件接收')).toBeInTheDocument();
    expect(screen.getByText('启用 LSL 实时输出')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'数据采集模式'})).toHaveAttribute('aria-pressed','true');
    fireEvent.click(screen.getByRole('button',{name:'电压标定'}));
    expect(await screen.findByLabelText('EEG单位标定')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'关闭设置',exact:true}));
    fireEvent.click(screen.getByRole('button',{name:'开始记录',exact:true}));
    expect(await screen.findByRole('button',{name:/停止记录/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'全部信号',exact:true}));
    expect(screen.getByRole('button',{name:/停止记录/})).toBeInTheDocument();
  });
  test('converts protocol u24 EEG values before raw display', () => {
    const values = extractChannelValues({
      timestamp: '2026-07-19T00:00:00.000Z',
      packet: {
        ppg: { ir1: 0, red1: 0, green1: 0, ir2: 0, red2: 0, green2: 0, accX: 0, accY: 0, accZ: 0 },
        eeg: { eeg1: 0xffffff, eeg2: 0x800000, eeg3: 0x7fffff, eeg4: 1 }
      }
    });

    expect(values.eeg1).toBe(-1);
    expect(values.eeg2).toBe(-8_388_608);
    expect(values.eeg3).toBe(8_388_607);
    expect(values.eeg4).toBe(1);
  });

  test('keeps persisted EEG mode when mounted under StrictMode', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...defaultSettings,
        displayMode: 'eeg',
        demoMode: true,
        eeg: {
          ...defaultSettings.eeg,
          timeWindowSeconds: 8
        }
      })
    );

    render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );

    expect(await screen.findByLabelText('睡眠指标')).toBeInTheDocument();

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { displayMode?: string };
      expect(stored.displayMode).toBe('eeg');
    });
  });

  test('toggles fullscreen from the F11 shortcut in browser preview', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen
    });

    render(<App />);
    fireEvent.keyDown(window, { key: 'F11' });

    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
    delete (document.documentElement as HTMLElement & {
      requestFullscreen?: () => Promise<void>;
    }).requestFullscreen;
  });

  test('toggles fullscreen from the macOS Control-Command-F shortcut', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen
    });

    render(<App />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true });

    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
    delete (document.documentElement as HTMLElement & {
      requestFullscreen?: () => Promise<void>;
    }).requestFullscreen;
  });

  test('exposes fullscreen beside settings and enters the algorithm-free acquisition workspace', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '全屏' }));
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '数据采集模式' }));
    expect(await screen.findByLabelText('数据采集模式界面')).toBeInTheDocument();
    expect(screen.getByText(/音乐、基线、分期和眨眼控制均已停用/)).toBeInTheDocument();
    expect(screen.queryByLabelText('睡眠指标')).not.toBeInTheDocument();

    delete (document.documentElement as HTMLElement & {
      requestFullscreen?: () => Promise<void>;
    }).requestFullscreen;
  });

  test('keeps the scan workflow active through automatic connection', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button',{name:'设备连接与采样率'}));
    fireEvent.click(screen.getByRole('button', { name: '扫描' }));

    expect(await screen.findByText('已连接：TD10 Preview')).toBeInTheDocument();
    expect(screen.getByText(/preview-device · 设备已连接：TD10 Preview · 125 Hz/)).toBeInTheDocument();
  });
});
