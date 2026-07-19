import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SleepMusicTrack } from '../domain/settings';
import { MusicLibraryModal } from './MusicLibraryModal';

const tracks: SleepMusicTrack[] = [
  {
    id: 'ocean',
    name: '海岸慢潮',
    path: '/audio/ocean-tide.ogg',
    category: 'nature',
    cover: 'ocean',
    source: 'builtin'
  },
  {
    id: 'rain',
    name: '雨幕白噪',
    path: '/audio/rain-window.ogg',
    category: 'white-noise',
    cover: 'rain',
    source: 'builtin'
  }
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderLibrary(overrides: Partial<Parameters<typeof MusicLibraryModal>[0]> = {}) {
  const props: Parameters<typeof MusicLibraryModal>[0] = {
    open: true,
    libraryTracks: tracks,
    playlistTracks: [tracks[1]],
    recentTrackIds: ['rain'],
    selectedTrackId: 'rain',
    onClose: vi.fn(),
    onImportTracks: vi.fn(async () => 0),
    onAddToPlaylist: vi.fn(),
    onRemoveFromPlaylist: vi.fn(),
    onSelectTrack: vi.fn(),
    onDeleteTrack: vi.fn(),
    onMoveTrack: vi.fn(),
    ...overrides
  };
  render(<MusicLibraryModal {...props} />);
  return props;
}

describe('MusicLibraryModal', () => {
  test('adds and selects a track from the visual library', () => {
    const props = renderLibrary();

    fireEvent.click(screen.getByRole('button', { name: '加入歌单并选择 海岸慢潮' }));

    expect(props.onAddToPlaylist).toHaveBeenCalledWith('ocean');
    expect(props.onSelectTrack).toHaveBeenCalledWith('ocean');
    expect(screen.getByRole('status')).toHaveTextContent('已加入助眠歌单');
  });

  test('arms for one second before starting a hover preview', async () => {
    renderLibrary();
    const cardButton = screen.getByRole('button', { name: '加入歌单并选择 海岸慢潮' });
    const card = cardButton.closest('article');
    expect(card).not.toBeNull();

    fireEvent.pointerEnter(card!);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.getByText('即将试听')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(screen.getByText('试听中')).toBeInTheDocument();

    fireEvent.pointerLeave(card!);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  test('cancels fast hover previews and does not autoplay on keyboard focus', async () => {
    renderLibrary();
    const card = document.querySelector<HTMLElement>('.music-library-card');
    const cardButton = card?.querySelector<HTMLButtonElement>('.music-card-main');
    expect(card).not.toBeNull();
    expect(cardButton).not.toBeNull();

    fireEvent.pointerEnter(card!);
    fireEvent.pointerLeave(card!);
    fireEvent.focus(cardButton!);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  test('filters the library and exposes playlist ordering controls', () => {
    const props = renderLibrary();

    fireEvent.change(screen.getByLabelText('搜索助眠音乐'), { target: { value: '雨幕' } });
    expect(screen.getByRole('button', { name: '选择 雨幕白噪' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加入歌单并选择 海岸慢潮' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '从播放队列移出 雨幕白噪' }));
    expect(props.onRemoveFromPlaylist).toHaveBeenCalledWith('rain');
    expect(screen.getByRole('button', { name: '上移 雨幕白噪' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下移 雨幕白噪' })).toBeDisabled();
  });
});
