import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  BrainCircuit,
  Check,
  Clock3,
  CloudRain,
  Headphones,
  Library,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Trees,
  Upload,
  Waves,
  X
} from 'lucide-react';
import { resolveAudioSource } from '../domain/music-player';
import type {
  SleepMusicCategory,
  SleepMusicCover,
  SleepMusicTrack
} from '../domain/settings';

type LibraryFilter = 'all' | 'recent' | SleepMusicCategory;

interface MusicLibraryModalProps {
  open: boolean;
  libraryTracks: SleepMusicTrack[];
  playlistTracks: SleepMusicTrack[];
  recentTrackIds: string[];
  selectedTrackId: string | null;
  onClose: () => void;
  onImportTracks: () => Promise<number>;
  onAddToPlaylist: (trackId: string) => void;
  onRemoveFromPlaylist: (trackId: string) => void;
  onSelectTrack: (trackId: string) => void;
  onDeleteTrack: (trackId: string) => void;
  onMoveTrack: (trackId: string, direction: -1 | 1) => void;
}

type CategoryMeta = {
  label: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
};

const CATEGORY_META: Record<SleepMusicCategory, CategoryMeta> = {
  brainwave: { label: '脑波音频', Icon: BrainCircuit },
  nature: { label: '自然声景', Icon: Trees },
  'white-noise': { label: '白噪音', Icon: CloudRain },
  meditation: { label: '冥想', Icon: Sparkles },
  other: { label: '本地音乐', Icon: Music2 }
};

const FILTERS: Array<{ value: LibraryFilter; label: string; Icon: CategoryMeta['Icon'] }> = [
  { value: 'all', label: '全部', Icon: Library },
  { value: 'recent', label: '最近', Icon: Clock3 },
  { value: 'brainwave', ...CATEGORY_META.brainwave },
  { value: 'nature', ...CATEGORY_META.nature },
  { value: 'white-noise', ...CATEGORY_META['white-noise'] },
  { value: 'meditation', ...CATEGORY_META.meditation }
];

const COVER_IMAGES: Record<SleepMusicCover, string> = {
  stars: new URL('../assets/sleep-music/cover-stars.jpg', import.meta.url).href,
  ocean: new URL('../assets/sleep-music/cover-ocean.jpg', import.meta.url).href,
  forest: new URL('../assets/sleep-music/cover-forest.jpg', import.meta.url).href,
  rain: new URL('../assets/sleep-music/cover-rain.jpg', import.meta.url).href,
  dawn: new URL('../assets/sleep-music/cover-dawn.jpg', import.meta.url).href
};

const PREVIEW_ARM_MS = 1_000;
const PREVIEW_LIMIT_MS = 12_000;

export function MusicLibraryModal({
  open,
  libraryTracks,
  playlistTracks,
  recentTrackIds,
  selectedTrackId,
  onClose,
  onImportTracks,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onSelectTrack,
  onDeleteTrack,
  onMoveTrack
}: MusicLibraryModalProps) {
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [query, setQuery] = useState('');
  const [armingTrackId, setArmingTrackId] = useState<string | null>(null);
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const playlistIds = useMemo(
    () => new Set(playlistTracks.map((track) => track.id)),
    [playlistTracks]
  );
  const recentRank = useMemo(
    () => new Map(recentTrackIds.map((trackId, index) => [trackId, index])),
    [recentTrackIds]
  );
  const filteredTracks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return libraryTracks
      .filter((track) => filter === 'all'
        || (filter === 'recent' ? recentRank.has(track.id) : resolveCategory(track) === filter))
      .filter((track) => !normalizedQuery
        || track.name.toLocaleLowerCase().includes(normalizedQuery)
        || CATEGORY_META[resolveCategory(track)].label.includes(normalizedQuery)
        || track.path.split(/[\\/]/).pop()?.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        if (filter !== 'recent') return 0;
        return (recentRank.get(left.id) ?? 999) - (recentRank.get(right.id) ?? 999);
      });
  }, [filter, libraryTracks, query, recentRank]);

  const clearTimer = (ref: { current: number | null }) => {
    if (ref.current !== null) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  };

  const stopPreview = useCallback(() => {
    clearTimer(armTimerRef);
    clearTimer(previewTimerRef);
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      if (Number.isFinite(audio.currentTime)) audio.currentTime = 0;
    }
    setArmingTrackId(null);
    setPreviewTrackId(null);
    setPreviewError(null);
  }, []);

  const showNotice = useCallback((message: string) => {
    clearTimer(noticeTimerRef);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, 2_200);
  }, []);

  const beginPreview = useCallback(async (track: SleepMusicTrack) => {
    clearTimer(armTimerRef);
    clearTimer(previewTimerRef);
    const audio = previewAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.src = resolveAudioSource(track.path);
    audio.volume = 0.24;
    audio.currentTime = 0;
    audio.load();
    setArmingTrackId(null);
    setPreviewTrackId(track.id);
    setPreviewError(null);
    try {
      await audio.play();
      previewTimerRef.current = window.setTimeout(stopPreview, PREVIEW_LIMIT_MS);
    } catch {
      setPreviewTrackId(null);
      setPreviewError(track.id);
    }
  }, [stopPreview]);

  const armPreview = useCallback((track: SleepMusicTrack) => {
    if (previewTrackId === track.id || armingTrackId === track.id) return;
    stopPreview();
    setArmingTrackId(track.id);
    armTimerRef.current = window.setTimeout(() => {
      armTimerRef.current = null;
      void beginPreview(track);
    }, PREVIEW_ARM_MS);
  }, [armingTrackId, beginPreview, previewTrackId, stopPreview]);

  useEffect(() => {
    if (!open) return;
    const audio = new Audio();
    audio.preload = 'metadata';
    previewAudioRef.current = audio;
    return () => {
      clearTimer(armTimerRef);
      clearTimer(previewTimerRef);
      clearTimer(noticeTimerRef);
      audio.pause();
      audio.removeAttribute('src');
      previewAudioRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) stopPreview();
  }, [open, stopPreview]);

  if (!open) return null;

  const handleBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) onClose();
  };

  const handleImport = async () => {
    setImporting(true);
    const imported = await onImportTracks();
    setImporting(false);
    if (imported > 0) {
      setFilter('all');
      showNotice(`已导入 ${imported} 首本地音频`);
    }
  };

  const activateTrack = (track: SleepMusicTrack) => {
    if (!playlistIds.has(track.id)) {
      onAddToPlaylist(track.id);
      showNotice(`已加入助眠歌单 · ${track.name}`);
    }
    onSelectTrack(track.id);
  };

  return (
    <div className="music-library-backdrop" onMouseDown={handleBackdrop}>
      <section
        ref={dialogRef}
        className="music-library-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="music-library-title"
      >
        <header className="music-library-header">
          <div className="music-library-heading">
            <span className="music-library-mark"><Headphones size={22} /></span>
            <div>
              <h2 id="music-library-title">助眠音乐库</h2>
              <span>{libraryTracks.length} 个声音 · {playlistTracks.length} 首歌单</span>
            </div>
          </div>
          <label className="music-library-search">
            <Search size={16} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索声音或文件"
              aria-label="搜索助眠音乐"
            />
          </label>
          <button
            type="button"
            className="music-library-import"
            onClick={() => void handleImport()}
            disabled={importing}
          >
            <Upload size={16} />
            <span>{importing ? '导入中' : '导入本地音乐'}</span>
          </button>
          <button type="button" className="music-library-close" onClick={onClose} aria-label="关闭音乐库" title="关闭">
            <X size={18} />
          </button>
        </header>

        <nav className="music-library-filters" aria-label="音乐分类">
          {FILTERS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="music-library-body">
          <div className="music-library-browser">
            <div className="music-library-section-title">
              <div>
                <strong>{resolveFilterTitle(filter)}</strong>
                <span>{filteredTracks.length} 个结果</span>
              </div>
              {previewError && <span className="music-preview-error" role="status">点击播放按钮授权试听</span>}
            </div>

            {filteredTracks.length > 0 ? (
              <div className="music-track-grid">
                {filteredTracks.map((track) => {
                  const inPlaylist = playlistIds.has(track.id);
                  const selected = selectedTrackId === track.id;
                  const previewing = previewTrackId === track.id;
                  const arming = armingTrackId === track.id;
                  const category = resolveCategory(track);
                  const categoryMeta = CATEGORY_META[category];
                  const CategoryIcon = categoryMeta.Icon;
                  return (
                    <article
                      className="music-library-card"
                      data-selected={selected}
                      data-preview={previewing ? 'playing' : arming ? 'arming' : 'idle'}
                      key={track.id}
                      onPointerEnter={() => armPreview(track)}
                      onPointerLeave={stopPreview}
                    >
                      <button
                        type="button"
                        className="music-card-main"
                        onClick={() => activateTrack(track)}
                        aria-label={`${inPlaylist ? '选择' : '加入歌单并选择'} ${track.name}`}
                      >
                        <span className="music-card-cover">
                          <img src={resolveCover(track)} alt="" draggable={false} />
                          <span className="music-card-shade" />
                          <span className="music-card-preview-state" aria-live="polite">
                            {previewing
                              ? <><AudioLines size={22} /><em>试听中</em></>
                              : arming
                                ? <><Clock3 size={18} /><em>即将试听</em></>
                                : <Play size={20} />}
                          </span>
                          {arming && <span className="music-preview-progress"><span /></span>}
                        </span>
                        <span className="music-card-copy">
                          <strong>{track.name}</strong>
                          <span><CategoryIcon size={13} />{categoryMeta.label}</span>
                        </span>
                      </button>
                      <div className="music-card-actions">
                        <button
                          type="button"
                          className="music-card-preview-button"
                          onClick={() => previewing ? stopPreview() : void beginPreview(track)}
                          aria-label={`${previewing ? '停止试听' : '试听'} ${track.name}`}
                          title={previewing ? '停止试听' : '试听'}
                        >
                          {previewing ? <Pause size={15} /> : <Play size={15} />}
                        </button>
                        <button
                          type="button"
                          className={`music-card-playlist-button ${inPlaylist ? 'is-added' : ''}`}
                          onClick={() => {
                            if (inPlaylist) {
                              onRemoveFromPlaylist(track.id);
                              showNotice(`已移出助眠歌单 · ${track.name}`);
                            } else {
                              onAddToPlaylist(track.id);
                              onSelectTrack(track.id);
                              showNotice(`已加入助眠歌单 · ${track.name}`);
                            }
                          }}
                          aria-label={`${inPlaylist ? '从音乐库卡片移出' : '加入'}助眠歌单 ${track.name}`}
                          title={inPlaylist ? '移出歌单' : '加入歌单'}
                        >
                          {inPlaylist ? <Check size={15} /> : <Plus size={15} />}
                        </button>
                        {track.source === 'local' && (
                          <button
                            type="button"
                            className="music-card-delete-button"
                            onClick={() => {
                              stopPreview();
                              onDeleteTrack(track.id);
                              showNotice(`已从音乐库移除 · ${track.name}`);
                            }}
                            aria-label={`从音乐库移除 ${track.name}`}
                            title="从音乐库移除"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="music-library-empty">
                <Waves size={28} />
                <strong>没有匹配的声音</strong>
                <button type="button" onClick={() => void handleImport()} disabled={importing}>
                  <Upload size={15} />导入本地音乐
                </button>
              </div>
            )}
          </div>

          <aside className="music-playlist-rail" aria-label="助眠歌单">
            <div className="music-playlist-head">
              <div>
                <span>PLAY NEXT</span>
                <h3>助眠歌单</h3>
              </div>
              <strong>{playlistTracks.length}</strong>
            </div>
            <div className="music-playlist-list" role="list">
              {playlistTracks.map((track, index) => (
                <div
                  className={`music-playlist-item ${selectedTrackId === track.id ? 'is-selected' : ''}`}
                  key={track.id}
                  role="listitem"
                >
                  <button type="button" className="music-playlist-select" onClick={() => onSelectTrack(track.id)}>
                    <img src={resolveCover(track)} alt="" draggable={false} />
                    <span>
                      <strong>{track.name}</strong>
                      <small>{CATEGORY_META[resolveCategory(track)].label}</small>
                    </span>
                  </button>
                  <div className="music-playlist-actions">
                    <button
                      type="button"
                      onClick={() => onMoveTrack(track.id, -1)}
                      disabled={index === 0}
                      aria-label={`上移 ${track.name}`}
                      title="上移"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMoveTrack(track.id, 1)}
                      disabled={index === playlistTracks.length - 1}
                      aria-label={`下移 ${track.name}`}
                      title="下移"
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveFromPlaylist(track.id)}
                      aria-label={`从播放队列移出 ${track.name}`}
                      title="移出歌单"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {playlistTracks.length === 0 && (
                <div className="music-playlist-empty">
                  <Music2 size={22} />
                  <span>歌单为空</span>
                </div>
              )}
            </div>
            {playlistTracks.length > 0 && (
              <div className="music-playlist-footer">
                <AudioLines size={15} />
                <span>{playlistTracks.find((track) => track.id === selectedTrackId)?.name ?? '等待选择'}</span>
              </div>
            )}
          </aside>
        </div>

        {notice && <div className="music-library-notice" role="status"><Check size={15} />{notice}</div>}
      </section>
    </div>
  );
}

function resolveCategory(track: SleepMusicTrack): SleepMusicCategory {
  return track.category ?? 'other';
}

function resolveCover(track: SleepMusicTrack): string {
  return COVER_IMAGES[track.cover ?? 'stars'];
}

function resolveFilterTitle(filter: LibraryFilter): string {
  if (filter === 'all') return '全部声音';
  if (filter === 'recent') return '最近播放';
  return CATEGORY_META[filter].label;
}
