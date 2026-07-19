import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings } from '../domain/settings';
import { SettingsPanel } from './SettingsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsPanel sleep guidance settings', () => {
  test('exposes the main demo controls and persists updates through onChange', () => {
    const onChange = vi.fn();
    const onOpenMusicLibrary = vi.fn();
    render(
      <SettingsPanel
        settings={{
          ...defaultSettings,
          demoMode: true,
          sleepMusic: {
            ...defaultSettings.sleepMusic,
            tracks: [{ id: 'one', name: '静夜引导', path: 'C:\\Music\\one.mp3' }],
            selectedTrackId: 'one'
          }
        }}
        onChange={onChange}
        sleepDemoStatus={{
          phase: 'calibrating',
          message: '睁眼基线测量中',
          alphaCalibrationSeconds: 20,
          closedEyeCalibrationSeconds: 20,
          blinkCalibrationSeconds: 10,
          lastResponse: null
        }}
        audioOutput={{
          devices: [{ deviceId: 'default', label: '系统默认输出' }],
          selectedDeviceId: 'default',
          supported: true,
          error: null
        }}
        onOpenMusicLibrary={onOpenMusicLibrary}
        onTestAudioOutput={vi.fn()}
      />
    );

    expect(screen.getByText('睡眠音乐引导')).toBeInTheDocument();
    expect(screen.getByText('1 首 · 静夜引导')).toBeInTheDocument();
    expect(screen.getByText('演示阶段')).toBeInTheDocument();
    expect(screen.getByText('判定与交互参数')).toBeInTheDocument();
    expect(screen.getByText('PC 睡眠算法服务')).toBeInTheDocument();
    expect(screen.getByText('睁眼基线')).toBeInTheDocument();
    expect(screen.getByText('闭眼基线')).toBeInTheDocument();
    expect(screen.getByText('眨眼基线')).toBeInTheDocument();
    expect(screen.getByText('准备：先静止 3 秒')).toBeInTheDocument();
    expect(screen.getByText('音频播放设备')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试声音' })).toBeEnabled();
    expect(screen.getByLabelText('信号显示时延')).toBeInTheDocument();
    expect(screen.getByText('原始滤波（全部波形）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /助眠歌单/ }));
    expect(onOpenMusicLibrary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('自动音乐：检测 Alpha 后播放'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      sleepMusic: expect.objectContaining({ autoMode: false })
    }));

    fireEvent.click(screen.getByLabelText('显示模式'));
    expect(screen.getByRole('option', { name: '调试记录' })).toBeInTheDocument();
  });
});
