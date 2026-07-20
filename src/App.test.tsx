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

  test('keeps the scan workflow active through automatic connection', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '扫描' }));

    expect(await screen.findByText('已连接：Preview BLE')).toBeInTheDocument();
    expect(screen.getByText('preview-device · 设备已连接：Preview BLE')).toBeInTheDocument();
  });
});
