export type DisplayMode = 'normal' | 'eeg';
export type ThemeName = 'neuro-dark' | 'clinical-light' | 'graphite' | 'amber-lab';
export type EegChannel = 'eeg1' | 'eeg2' | 'eeg3' | 'eeg4';
export type AutoNumber = 'auto' | number;
export type EegBandKey = 'delta' | 'theta' | 'alpha' | 'beta';

export const themeOptions: Array<{ value: ThemeName; label: string }> = [
  { value: 'neuro-dark', label: 'Neuro Dark' },
  { value: 'clinical-light', label: 'Clinical Light' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'amber-lab', label: 'Amber Lab' }
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
}

export interface AppSettings {
  displayMode: DisplayMode;
  theme: ThemeName;
  autoReconnect: boolean;
  warmupDelaySeconds: number;
  recordDir: string;
  showChartsOnly: boolean;
  filterEnabled: boolean;
  filterLow: number;
  filterHigh: number;
  kalmanEnabled: boolean;
  kalmanQ: number;
  kalmanR: number;
  visibleChannels: Record<string, boolean>;
  eeg: EegSettings;
}

const STORAGE_KEY = 'ifet-eeg-client-settings';

export const defaultSettings: AppSettings = {
  displayMode: 'normal',
  theme: 'neuro-dark',
  autoReconnect: false,
  warmupDelaySeconds: 5,
  recordDir: '',
  showChartsOnly: false,
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
      delta: { low: 0.5, high: 4 },
      theta: { low: 4, high: 8 },
      alpha: { low: 8, high: 13 },
      beta: { low: 13, high: 30 }
    }
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
  return {
    ...base,
    ...value,
    visibleChannels: {
      ...base.visibleChannels,
      ...value.visibleChannels
    },
    eeg: {
      ...base.eeg,
      ...value.eeg,
      bandRanges: {
        ...base.eeg.bandRanges,
        ...value.eeg?.bandRanges
      }
    }
  };
}
