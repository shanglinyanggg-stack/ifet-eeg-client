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

const ACQUISITION_SAMPLE_RATE = 125;
const MODEL_SAMPLE_RATE = 100;
const STAGING_STEP_SAMPLES = MODEL_SAMPLE_RATE * 5;
const DEMO_STEP_SAMPLES = MODEL_SAMPLE_RATE / 2;

abstract class AlgorithmChunkAssembler<TRequest> {
  private samples: StagingSample[] = [];
  private previousSequence: number | null = null;
  private resampler = new FixedRateResampler(ACQUISITION_SAMPLE_RATE, MODEL_SAMPLE_RATE);

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
          this.pushAcquisitionSample(invalidSample(event.timestamp));
        }
      }
    }

    if (sequence !== null) this.previousSequence = sequence;
    this.pushAcquisitionSample(sampleFromEvent(event));
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
    this.resampler = new FixedRateResampler(ACQUISITION_SAMPLE_RATE, MODEL_SAMPLE_RATE);
  }

  protected abstract createRequest(sessionId: string, samples: StagingSample[]): TRequest;

  private pushAcquisitionSample(sample: StagingSample): void {
    this.samples.push(...this.resampler.push(sample));
  }

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

/**
 * The headset is acquired and recorded at its native 125 Hz. The deployed
 * sleep models remain fixed at their validated 100 Hz input contract, so the
 * conversion lives only at this boundary. Linear time-grid interpolation is
 * deterministic for the 4:5 ratio; invalid transport gaps stay invalid and
 * are never filled with apparently valid EEG.
 */
class FixedRateResampler {
  private previous: StagingSample | null = null;
  private inputIndex = -1;
  private nextOutputPosition = 0;
  private readonly inputSamplesPerOutput: number;

  constructor(inputRate: number, outputRate: number) {
    this.inputSamplesPerOutput = inputRate / outputRate;
  }

  push(sample: StagingSample): StagingSample[] {
    this.inputIndex += 1;
    if (this.previous === null) {
      this.previous = sample;
      this.nextOutputPosition += this.inputSamplesPerOutput;
      return [sample];
    }

    const output: StagingSample[] = [];
    while (this.nextOutputPosition <= this.inputIndex + 1e-9) {
      const fraction = this.nextOutputPosition - (this.inputIndex - 1);
      output.push(interpolateSample(this.previous, sample, fraction));
      this.nextOutputPosition += this.inputSamplesPerOutput;
    }
    this.previous = sample;
    return output;
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

function interpolateSample(
  left: StagingSample,
  right: StagingSample,
  fraction: number
): StagingSample {
  if (fraction <= 1e-9) return left;
  if (fraction >= 1 - 1e-9) return right;
  const timestamp = interpolateTimestamp(left.timestamp, right.timestamp, fraction);
  if (!left.valid || !right.valid) return invalidSample(timestamp);
  return {
    timestamp,
    eeg: left.eeg.map(
      (value, channel) => value + (right.eeg[channel] - value) * fraction
    ) as [number, number, number, number],
    imu: left.imu.map(
      (value, channel) => value + (right.imu[channel] - value) * fraction
    ) as [number, number, number],
    valid: true
  };
}

function interpolateTimestamp(left: string, right: string, fraction: number): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return right;
  return new Date(leftMs + (rightMs - leftMs) * fraction).toISOString();
}

export function signedU24(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) return value;
  return value >= 0x800000 ? value - 0x1000000 : value;
}

function normalizeSequence(value: number | null | undefined): number | null {
  if (!Number.isInteger(value)) return null;
  return ((Number(value) % 256) + 256) % 256;
}
