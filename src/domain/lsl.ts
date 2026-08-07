export interface LslStreamSummary {
  name: string;
  streamType: string;
  channelCount: number;
  nominalSampleRateHz: number;
  channelFormat: string;
}

export interface LslStatus {
  enabled: boolean;
  running: boolean;
  hasConsumers: boolean;
  message: string;
  streamName: string;
  sourceId: string;
  sampleRateHz: number;
  samplesPublished: number;
  markersPublished: number;
  droppedBatches: number;
  protocolVersion: string;
  libraryVersion: string;
  lastError: string | null;
  streams: LslStreamSummary[];
}

export const initialLslStatus: LslStatus = {
  enabled: false,
  running: false,
  hasConsumers: false,
  message: 'LSL 未启用',
  streamName: 'iFET-TD10',
  sourceId: 'ifet-td10-headset',
  sampleRateHz: 125,
  samplesPublished: 0,
  markersPublished: 0,
  droppedBatches: 0,
  protocolVersion: '1.10',
  libraryVersion: '1.13',
  lastError: null,
  streams: []
};
