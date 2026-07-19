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
        onOpenMusicLibrary={onOpenMusicLibrary}
      />
    );

    expect(screen.getByText('睡眠音乐引导')).toBeInTheDocument();
    expect(screen.getByText('1 首 · 静夜引导')).toBeInTheDocument();
    expect(screen.getByText('演示阶段')).toBeInTheDocument();
    expect(screen.getByText('判定与交互参数')).toBeInTheDocument();
    expect(screen.getByText('PC 睡眠算法服务')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /助眠歌单/ }));
    expect(onOpenMusicLibrary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('自动播放控制'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      sleepMusic: expect.objectContaining({ autoMode: false })
    }));
  });
});
