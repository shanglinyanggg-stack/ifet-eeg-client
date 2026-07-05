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

// 定长环形缓冲，避免每样本拷贝整条缓冲
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buffer = new Array(this.capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  get length(): number {
    return this.size;
  }

  at(index: number): T | undefined {
    if (index < 0 || index >= this.size) return undefined;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return this.buffer[(start + index) % this.capacity];
  }

  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      out.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return out;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

export function createEegBands(): EegBandDefinition[] {
  return [
    { key: 'delta', label: 'Delta', low: 0.5, high: 4, color: '#60a5fa' },
    { key: 'theta', label: 'Theta', low: 4, high: 8, color: '#a78bfa' },
    { key: 'alpha', label: 'Alpha', low: 8, high: 13, color: '#22c55e' },
    { key: 'beta', label: 'Beta', low: 13, high: 30, color: '#f59e0b' }
  ];
}

// 协议未携带采样率字段，统一常量；后续若协议扩展应改为从设置/协议读取
export const EEG_SAMPLE_RATE = 100;

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

  static notch(frequency: number, sampleRate: number, q = 30): Biquad {
    const safeQ = Math.max(q, 0.01);
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const alpha = Math.sin(omega) / (2 * safeQ);
    const a0 = 1 + alpha;
    return new Biquad(
      1 / a0,
      (-2 * Math.cos(omega)) / a0,
      1 / a0,
      (-2 * Math.cos(omega)) / a0,
      (1 - alpha) / a0
    );
  }

  process(input: number): number {
    const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }

  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

// 串接多个 Biquad 形成滤波链，保持跨渲染状态，避免每帧重建带来的启动瞬态
export class FilterChain {
  private readonly stages: Biquad[];
  constructor(stages: Biquad[]) {
    this.stages = stages;
  }

  static bandpassWithNotch(opts: {
    enabled: boolean;
    low: number;
    high: number;
    notch: 'off' | 50 | 60;
    sampleRate: number;
  }): FilterChain {
    const stages: Biquad[] = [];
    if (opts.enabled && opts.high > opts.low) {
      stages.push(Biquad.bandpass(opts.low, opts.high, opts.sampleRate));
    }
    if (opts.notch !== 'off') {
      stages.push(Biquad.notch(opts.notch, opts.sampleRate));
    }
    return new FilterChain(stages);
  }

  process(input: number): number {
    let value = input;
    for (const stage of this.stages) {
      value = stage.process(value);
    }
    return value;
  }

  reset() {
    for (const stage of this.stages) {
      stage.reset();
    }
  }

  get length() {
    return this.stages.length;
  }
}

// 一阶卡尔曼滤波，保持跨渲染状态
export class KalmanFilter {
  private estimate = 0;
  private errorCovariance = 1;
  private initialized = false;

  constructor(
    private readonly processNoise: number,
    private readonly measurementNoise: number
  ) {}

  reset() {
    this.estimate = 0;
    this.errorCovariance = 1;
    this.initialized = false;
  }

  process(measurement: number): number {
    if (!this.initialized) {
      this.estimate = measurement;
      this.errorCovariance = 1;
      this.initialized = true;
      return measurement;
    }

    // 预测
    const predictedError = this.errorCovariance + this.processNoise;
    // 增益
    const gain = predictedError / (predictedError + this.measurementNoise);
    // 更新
    this.estimate = this.estimate + gain * (measurement - this.estimate);
    this.errorCovariance = (1 - gain) * predictedError;
    return this.estimate;
  }
}

// 跨渲染缓存的卡尔曼滤波注册表，按通道+Q+R 为 key
export class KalmanRegistry {
  private entries = new Map<string, KalmanFilter>();

  get(channel: string, q: number, r: number): KalmanFilter {
    const key = `${channel}|${q}|${r}`;
    const existing = this.entries.get(key);
    if (existing) return existing;
    const filter = new KalmanFilter(q, r);
    this.entries.set(key, filter);
    return filter;
  }
}
