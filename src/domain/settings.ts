export type DisplayMode = 'normal' | 'eeg' | 'debug';
export type ThemeName = 'neuro-dark' | 'clinical-light' | 'graphite' | 'amber-lab' | 'aurora-violet' | 'porcelain';
export type EegChannel = 'eeg1' | 'eeg2' | 'eeg3' | 'eeg4';
export type AutoNumber = 'auto' | number;
export type EegBandKey = 'delta' | 'theta' | 'alpha' | 'beta';
// 纯波形模式专用频带：α / β / γ / δ（无 θ，新增 γ）
export type EegPureBandKey = 'delta' | 'alpha' | 'beta' | 'gamma';
export type SleepMusicCategory = 'brainwave' | 'nature' | 'white-noise' | 'meditation' | 'other';
export type SleepMusicCover = 'stars' | 'ocean' | 'forest' | 'rain' | 'dawn';
export type SleepMusicSource = 'builtin' | 'local';
export type AlphaVolumeMode = '3' | '10' | '20' | 'smooth';
export type DrowsinessMode = 'v025' | 'wearable-trial';
export type BleSampleRate = 125 | 250 | 500 | 1000;

export interface SleepMusicTrack {
  id: string;
  name: string;
  path: string;
  category?: SleepMusicCategory;
  cover?: SleepMusicCover;
  source?: SleepMusicSource;
}

export interface SleepMusicSettings {
  enabled: boolean;
  autoMode: boolean;
  alphaVolumeControlEnabled: boolean;
  sleepStopEnabled: boolean;
  libraryTracks: SleepMusicTrack[];
  tracks: SleepMusicTrack[];
  recentTrackIds: string[];
  selectedTrackId: string | null;
  baseVolume: number;
  maximumVolume: number;
  transitionVolume: number;
  stopFadeSeconds: number;
  audioOutputDeviceId: string;
  serviceEnabled: boolean;
  serviceEndpoint: string;
  drowsinessMode: DrowsinessMode;
  alphaVolumeMode: AlphaVolumeMode;
  blinkControlEnabled: boolean;
  blinkVolumeStep: number;
  relaxAlphaThreshold: number;
  fadeSleepScoreThreshold: number;
  stopSleepScoreThreshold: number;
  relaxConfirmSeconds: number;
  transitionConfirmSeconds: number;
  sleepConfirmSeconds: number;
  awakeConfirmSeconds: number;
  emaAlpha: number;
  minimumCoverage: number;
  audienceCues: boolean;
  demoPhase: 'live' | 'ready' | 'relaxing' | 'transition' | 'light-sleep' | 'signal-poor';
}

export const themeOptions: Array<{ value: ThemeName; label: string }> = [
  { value: 'neuro-dark', label: 'Neuro Dark' },
  { value: 'clinical-light', label: 'Clinical Light' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'amber-lab', label: 'Amber Lab' },
  { value: 'aurora-violet', label: 'Aurora Violet' },
  { value: 'porcelain', label: 'Porcelain' }
];

export const eegScaleOptions = [
  { value: 'auto', label: 'auto' },
  { value: '20', label: '20' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '200', label: '200' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' }
];

export const eegTimeWindowOptions = [
  { value: 'auto', label: 'auto' },
  { value: '3', label: '3 s' },
  { value: '5', label: '5 s' },
  { value: '8', label: '8 s' },
  { value: '10', label: '10 s' },
  { value: '15', label: '15 s' },
  { value: '30', label: '30 s' }
];

export const displayDelayOptions = [
  { value: '0', label: '实时' },
  { value: '250', label: '0.25 s' },
  { value: '500', label: '0.5 s' },
  { value: '1000', label: '1.0 s' },
  { value: '2000', label: '2.0 s' }
];

export const builtInSleepTracks: SleepMusicTrack[] = [
  {
    id: 'builtin-star-alpha',
    name: '星河 Alpha',
    path: '/audio/star-alpha.ogg',
    category: 'brainwave',
    cover: 'stars',
    source: 'builtin'
  },
  {
    id: 'builtin-ocean-tide',
    name: '海岸慢潮',
    path: '/audio/ocean-tide.ogg',
    category: 'nature',
    cover: 'ocean',
    source: 'builtin'
  },
  {
    id: 'builtin-forest-morning',
    name: '林间晨息',
    path: '/audio/forest-morning.ogg',
    category: 'nature',
    cover: 'forest',
    source: 'builtin'
  },
  {
    id: 'builtin-rain-window',
    name: '雨幕白噪',
    path: '/audio/rain-window.ogg',
    category: 'white-noise',
    cover: 'rain',
    source: 'builtin'
  },
  {
    id: 'builtin-dawn-breath',
    name: '晨光呼吸',
    path: '/audio/dawn-breath.ogg',
    category: 'meditation',
    cover: 'dawn',
    source: 'builtin'
  }
];

export interface BandRange {
  low: number;
  high: number;
}

export interface EegSettings {
  selectedChannel: EegChannel;
  scale: AutoNumber;
  timeWindowSeconds: AutoNumber;
  bandpassEnabled: boolean;
  bandpassLow: number;
  bandpassHigh: number;
  notch: 'off' | 50 | 60;
  bandRanges: Record<EegBandKey, BandRange>;
  pure: {
    bandRanges: Record<EegPureBandKey, BandRange>;
    bandScales: Record<EegPureBandKey, AutoNumber>;
  };
}

export interface AppSettings {
  bleSampleRateHz: BleSampleRate;
  displayMode: DisplayMode;
  displayDelayMs: number;
  theme: ThemeName;
  autoReconnect: boolean;
  warmupDelaySeconds: number;
  recordDir: string;
  showChartsOnly: boolean;
  demoMode: boolean;
  filterEnabled: boolean;
  filterLow: number;
  filterHigh: number;
  kalmanEnabled: boolean;
  kalmanQ: number;
  kalmanR: number;
  visibleChannels: Record<string, boolean>;
  eeg: EegSettings;
  sleepMusic: SleepMusicSettings;
}

const STORAGE_KEY = 'ifet-eeg-client-settings';

export const defaultSettings: AppSettings = {
  bleSampleRateHz: 125,
  displayMode: 'normal',
  displayDelayMs: 0,
  theme: 'neuro-dark',
  autoReconnect: false,
  warmupDelaySeconds: 5,
  recordDir: '',
  showChartsOnly: false,
  demoMode: false,
  filterEnabled: false,
  filterLow: 0.5,
  filterHigh: 5,
  kalmanEnabled: false,
  kalmanQ: 1,
  kalmanR: 50,
  visibleChannels: {
    ir1: true,
    red1: true,
    green1: true,
    ir2: true,
    red2: true,
    green2: true,
    accX: true,
    accY: true,
    accZ: true,
    eeg1: true,
    eeg2: true,
    eeg3: true,
    eeg4: true
  },
  eeg: {
    selectedChannel: 'eeg1',
    scale: 'auto',
    timeWindowSeconds: 'auto',
    bandpassEnabled: false,
    bandpassLow: 0.5,
    bandpassHigh: 30,
    notch: 'off',
    bandRanges: {
      delta: { low: 0.5, high: 2 },
      theta: { low: 4, high: 7 },
      alpha: { low: 8, high: 13 },
      beta: { low: 13, high: 30 }
    },
    pure: {
      bandRanges: {
        delta: { low: 0.5, high: 2 },
        alpha: { low: 8, high: 13 },
        beta: { low: 13, high: 30 },
        gamma: { low: 30, high: 45 }
      },
      bandScales: {
        delta: 'auto',
        alpha: 'auto',
        beta: 'auto',
        gamma: 'auto'
      }
    }
  },
  sleepMusic: {
    enabled: true,
    autoMode: true,
    alphaVolumeControlEnabled: true,
    sleepStopEnabled: true,
    libraryTracks: builtInSleepTracks.map((track) => ({ ...track })),
    tracks: [],
    recentTrackIds: [],
    selectedTrackId: null,
    baseVolume: 0.6,
    maximumVolume: 0.8,
    transitionVolume: 0.18,
    stopFadeSeconds: 8,
    audioOutputDeviceId: 'default',
    serviceEnabled: true,
    serviceEndpoint: 'http://127.0.0.1:8776',
    drowsinessMode: 'wearable-trial',
    alphaVolumeMode: '3',
    blinkControlEnabled: false,
    blinkVolumeStep: 0.1,
    relaxAlphaThreshold: 0.32,
    fadeSleepScoreThreshold: 45,
    stopSleepScoreThreshold: 68,
    relaxConfirmSeconds: 2,
    transitionConfirmSeconds: 1,
    sleepConfirmSeconds: 3,
    awakeConfirmSeconds: 3,
    emaAlpha: 0.25,
    minimumCoverage: 0.6,
    audienceCues: true,
    demoPhase: 'live'
  }
};

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultSettings;

  try {
    return mergeSettings(defaultSettings, JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function mergeSettings(base: AppSettings, value: Partial<AppSettings>): AppSettings {
  const bleSampleRateHz = isBleSampleRate(value.bleSampleRateHz)
    ? value.bleSampleRateHz
    : base.bleSampleRateHz;
  const tracks = Array.isArray(value.sleepMusic?.tracks)
    ? sanitizeTracks(value.sleepMusic.tracks, 24)
    : base.sleepMusic.tracks;
  const savedLibraryTracks = Array.isArray(value.sleepMusic?.libraryTracks)
    ? sanitizeTracks(value.sleepMusic.libraryTracks, 120)
    : [];
  const libraryTracks = mergeTrackCollections(
    base.sleepMusic.libraryTracks,
    savedLibraryTracks,
    tracks
  ).slice(0, 120);
  const recentTrackIds = Array.isArray(value.sleepMusic?.recentTrackIds)
    ? value.sleepMusic.recentTrackIds
      .filter((trackId): trackId is string => typeof trackId === 'string')
      .filter((trackId) => libraryTracks.some((track) => track.id === trackId))
      .slice(0, 12)
    : base.sleepMusic.recentTrackIds;
  const requestedTrackId = value.sleepMusic?.selectedTrackId ?? base.sleepMusic.selectedTrackId;
  const savedDeltaRange = value.eeg?.bandRanges?.delta;
  const savedPureDeltaRange = value.eeg?.pure?.bandRanges?.delta;
  // v0.2.5 and earlier stored 0.5-4 Hz as the default. Migrate only that
  // legacy default; explicitly customised ranges remain untouched.
  const migratedDeltaRange = savedDeltaRange?.low === 0.5 && savedDeltaRange.high === 4
    ? base.eeg.bandRanges.delta
    : savedDeltaRange;
  const migratedPureDeltaRange = savedPureDeltaRange?.low === 0.5 && savedPureDeltaRange.high === 4
    ? base.eeg.pure.bandRanges.delta
    : savedPureDeltaRange;
  const migratedServiceEndpoint = value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8768'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8769'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8770'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8771'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8772'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8773'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8774'
    || value.sleepMusic?.serviceEndpoint === 'http://127.0.0.1:8775'
    ? base.sleepMusic.serviceEndpoint
    : value.sleepMusic?.serviceEndpoint;
  return {
    ...base,
    ...value,
    bleSampleRateHz,
    visibleChannels: {
      ...base.visibleChannels,
      ...value.visibleChannels
    },
    eeg: {
      ...base.eeg,
      ...value.eeg,
      bandRanges: {
        ...base.eeg.bandRanges,
        ...value.eeg?.bandRanges,
        ...(migratedDeltaRange ? { delta: migratedDeltaRange } : {})
      },
      pure: {
        bandRanges: {
          ...base.eeg.pure.bandRanges,
          ...value.eeg?.pure?.bandRanges,
          ...(migratedPureDeltaRange ? { delta: migratedPureDeltaRange } : {})
        },
        bandScales: {
          ...base.eeg.pure.bandScales,
          ...value.eeg?.pure?.bandScales
        }
      }
    },
    sleepMusic: {
      ...base.sleepMusic,
      ...value.sleepMusic,
      ...(migratedServiceEndpoint ? { serviceEndpoint: migratedServiceEndpoint } : {}),
      libraryTracks,
      tracks,
      recentTrackIds,
      selectedTrackId: tracks.some((track) => track.id === requestedTrackId)
        ? requestedTrackId
        : tracks[0]?.id ?? null
    }
  };
}

function isBleSampleRate(value: unknown): value is BleSampleRate {
  return value === 125 || value === 250 || value === 500 || value === 1_000;
}

function sanitizeTracks(value: SleepMusicTrack[], limit: number): SleepMusicTrack[] {
  return value
    .filter((track) => track
      && typeof track.id === 'string'
      && typeof track.name === 'string'
      && typeof track.path === 'string'
      && !track.path.startsWith('blob:'))
    .map((track) => ({ ...track }))
    .slice(0, limit);
}

function mergeTrackCollections(...groups: SleepMusicTrack[][]): SleepMusicTrack[] {
  const tracks = new Map<string, SleepMusicTrack>();
  for (const group of groups) {
    for (const track of group) tracks.set(track.path, track);
  }
  return Array.from(tracks.values());
}
