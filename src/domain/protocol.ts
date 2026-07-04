export interface PpgSample {
  ir1: number;
  red1: number;
  green1: number;
  ir2: number;
  red2: number;
  green2: number;
  accX: number;
  accY: number;
  accZ: number;
}

export interface EegSample {
  eeg1: number;
  eeg2: number;
  eeg3: number;
  eeg4: number;
  flag?: number | null;
}

export interface DecodedPacket {
  sequence?: number | null;
  ppg: PpgSample;
  eeg?: EegSample | null;
}

export interface SampleEvent {
  timestamp: string;
  packet: DecodedPacket;
}

export interface DeviceInfo {
  id: string;
  name: string;
  rssi: number;
}

export interface StatusEvent {
  message: string;
  connected: boolean;
}

export type ChannelKey =
  | keyof PpgSample
  | keyof Omit<EegSample, 'flag'>;

export const channelLabels: Record<ChannelKey, string> = {
  ir1: 'IR1',
  red1: 'Red1',
  green1: 'Green1',
  ir2: 'IR2',
  red2: 'Red2',
  green2: 'Green2',
  accX: 'AccX',
  accY: 'AccY',
  accZ: 'AccZ',
  eeg1: 'EEG1',
  eeg2: 'EEG2',
  eeg3: 'EEG3',
  eeg4: 'EEG4'
};

export const channelColors: Record<ChannelKey, string> = {
  ir1: '#8b5cf6',
  red1: '#ef4444',
  green1: '#22c55e',
  ir2: '#a855f7',
  red2: '#fb7185',
  green2: '#84cc16',
  accX: '#f97316',
  accY: '#facc15',
  accZ: '#fb923c',
  eeg1: '#38bdf8',
  eeg2: '#818cf8',
  eeg3: '#2dd4bf',
  eeg4: '#f59e0b'
};
