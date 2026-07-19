import type { SampleEvent } from './protocol';

export interface SleepStagingStepRequest {
  session_id: string;
  timestamp: string;
  eeg_5s: [number[], number[], number[], number[]];
  imu_5s: [number[], number[], number[]];
  valid_5s: boolean[];
}

export interface SleepDemoStepRequest {
  session_id: string;
  timestamp: string;
  eeg: [number[], number[], number[], number[]];
  imu: [number[], number[], number[]];
  valid: boolean[];
}

interface StagingSample {
  timestamp: string;
  eeg: [number, number, number, number];
  imu: [number, number, number];
  valid: boolean;
}

const STAGING_STEP_SAMPLES = 500;
const DEMO_STEP_SAMPLES = 50;

abstract class AlgorithmChunkAssembler<TRequest> {
  private samples: StagingSample[] = [];
  private previousSequence: number | null = null;

  protected constructor(private sessionId: string, private readonly chunkSamples: number) {}

  get pendingSamples(): number {
    return this.samples.length;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  push(event: SampleEvent): TRequest[] {
    const sequence = normalizeSequence(event.packet.sequence);
    if (sequence !== null && this.previousSequence !== null) {
      const delta = (sequence - this.previousSequence + 256) % 256;
      if (delta === 0) return [];
      if (delta <= 128) {
        for (let missing = 1; missing < delta; missing += 1) {
          this.samples.push(invalidSample(event.timestamp));
        }
      }
    }

    if (sequence !== null) this.previousSequence = sequence;
    this.samples.push(sampleFromEvent(event));
    return this.takeReadyChunks();
  }

  pushMany(events: SampleEvent[]): TRequest[] {
    const chunks: TRequest[] = [];
    for (const event of events) chunks.push(...this.push(event));
    return chunks;
  }

  reset(sessionId: string): void {
    this.sessionId = sessionId;
    this.samples = [];
    this.previousSequence = null;
  }

  protected abstract createRequest(sessionId: string, samples: StagingSample[]): TRequest;

  private takeReadyChunks(): TRequest[] {
    const chunks: TRequest[] = [];
    while (this.samples.length >= this.chunkSamples) {
      chunks.push(this.createRequest(
        this.sessionId,
        this.samples.splice(0, this.chunkSamples)
      ));
    }
    return chunks;
  }
}

export class SleepStagingChunkAssembler extends AlgorithmChunkAssembler<SleepStagingStepRequest> {
  constructor(sessionId: string) {
    super(sessionId, STAGING_STEP_SAMPLES);
  }

  protected createRequest(sessionId: string, samples: StagingSample[]): SleepStagingStepRequest {
    return {
      session_id: sessionId,
      timestamp: samples[samples.length - 1].timestamp,
      eeg_5s: mapEeg(samples),
      imu_5s: mapImu(samples),
      valid_5s: samples.map((sample) => sample.valid)
    };
  }
}

export class SleepDemoChunkAssembler extends AlgorithmChunkAssembler<SleepDemoStepRequest> {
  constructor(sessionId: string) {
    super(sessionId, DEMO_STEP_SAMPLES);
  }

  protected createRequest(sessionId: string, samples: StagingSample[]): SleepDemoStepRequest {
    return {
      session_id: sessionId,
      timestamp: samples[samples.length - 1].timestamp,
      eeg: mapEeg(samples),
      imu: mapImu(samples),
      valid: samples.map((sample) => sample.valid)
    };
  }
}

function mapEeg(samples: StagingSample[]): [number[], number[], number[], number[]] {
  return [0, 1, 2, 3].map(
    (channel) => samples.map((sample) => sample.eeg[channel])
  ) as [number[], number[], number[], number[]];
}

function mapImu(samples: StagingSample[]): [number[], number[], number[]] {
  return [0, 1, 2].map(
    (channel) => samples.map((sample) => sample.imu[channel])
  ) as [number[], number[], number[]];
}

function sampleFromEvent(event: SampleEvent): StagingSample {
  if (event.valid === false) return invalidSample(event.timestamp);
  const eeg = event.packet.eeg;
  const ppg = event.packet.ppg;
  const values = eeg
    ? [eeg.eeg1, eeg.eeg2, eeg.eeg3, eeg.eeg4, ppg.accX, ppg.accY, ppg.accZ]
    : [];
  if (values.length !== 7 || values.some((value) => !Number.isFinite(value))) {
    return invalidSample(event.timestamp);
  }

  return {
    timestamp: event.timestamp,
    eeg: [
      signedU24(eeg!.eeg1),
      signedU24(eeg!.eeg2),
      signedU24(eeg!.eeg3),
      signedU24(eeg!.eeg4)
    ],
    imu: [ppg.accX, ppg.accY, ppg.accZ],
    valid: true
  };
}

function invalidSample(timestamp: string): StagingSample {
  return {
    timestamp,
    eeg: [0, 0, 0, 0],
    imu: [0, 0, 0],
    valid: false
  };
}

export function signedU24(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) return value;
  return value >= 0x800000 ? value - 0x1000000 : value;
}

function normalizeSequence(value: number | null | undefined): number | null {
  if (!Number.isInteger(value)) return null;
  return ((Number(value) % 256) + 256) % 256;
}
