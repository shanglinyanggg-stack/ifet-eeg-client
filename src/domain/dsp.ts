import type { AutoNumber } from './settings';

export interface TimedValue {
  timestamp: number;
  value: number;
}

export interface BandValue {
  label: 'Delta' | 'Theta' | 'Alpha' | 'Beta';
  value: number;
}

export interface BandShare extends BandValue {
  percent: number;
}

export interface EegBandDefinition {
  key: 'delta' | 'theta' | 'alpha' | 'beta';
  label: BandValue['label'];
  low: number;
  high: number;
  color: string;
}

export function appendSample(buffer: TimedValue[], sample: TimedValue, maxPoints: number): TimedValue[] {
  const next = [...buffer, sample];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

export function createEegBands(): EegBandDefinition[] {
  return [
    { key: 'delta', label: 'Delta', low: 0.5, high: 4, color: '#60a5fa' },
    { key: 'theta', label: 'Theta', low: 4, high: 8, color: '#a78bfa' },
    { key: 'alpha', label: 'Alpha', low: 8, high: 13, color: '#22c55e' },
    { key: 'beta', label: 'Beta', low: 13, high: 30, color: '#f59e0b' }
  ];
}

export function computeShare(values: BandValue[]): BandShare[] {
  const total = values.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= Number.EPSILON) {
    return values.map((item) => ({ ...item, percent: 0 }));
  }
  return values.map((item) => ({
    ...item,
    percent: Math.round((Math.max(0, item.value) / total) * 100)
  }));
}

export function resolveScale(scale: AutoNumber, values: number[]): number {
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
    return scale;
  }
  if (values.length === 0) return 1;
  const maxAbs = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  return Math.max(1, Math.ceil(maxAbs * 1.2));
}

export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number
  ) {}

  static bandpass(lowCut: number, highCut: number, sampleRate: number): Biquad {
    const center = Math.sqrt(lowCut * highCut);
    const bandwidth = Math.max(highCut - lowCut, 1e-6);
    const q = Math.max(center / bandwidth, 0.01);
    const omega = (2 * Math.PI * center) / sampleRate;
    const alpha = Math.sin(omega) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad(alpha / a0, 0, -alpha / a0, (-2 * Math.cos(omega)) / a0, (1 - alpha) / a0);
  }

  process(input: number): number {
    const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}
