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

export function appendSamples(buffer: TimedValue[], samples: TimedValue[], maxPoints: number): TimedValue[] {
  if (samples.length === 0) return buffer;
  const limit = Math.max(1, Math.floor(maxPoints));
  const overflow = buffer.length + samples.length - limit;
  if (overflow <= 0) return [...buffer, ...samples];
  if (overflow >= buffer.length) return samples.slice(samples.length - limit);
  return [...buffer.slice(overflow), ...samples];
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
    { key: 'theta', label: 'Theta', low: 4, high: 7, color: '#a78bfa' },
    { key: 'alpha', label: 'Alpha', low: 8, high: 13, color: '#22c55e' },
    { key: 'beta', label: 'Beta', low: 13, high: 30, color: '#f59e0b' }
  ];
}

// 纯波形模式频带：δ / α / β / γ，γ 受 100Hz 采样率 Nyquist 限制取 30~45Hz
export type PureBandKey = 'delta' | 'alpha' | 'beta' | 'gamma';

export interface PureBandDefinition {
  key: PureBandKey;
  label: string;
  symbol: string;
  low: number;
  high: number;
  color: string;
}

export function createPureBands(): PureBandDefinition[] {
  return [
    { key: 'delta', label: 'Delta', symbol: 'δ', low: 0.5, high: 4, color: '#60a5fa' },
    { key: 'alpha', label: 'Alpha', symbol: 'α', low: 8, high: 13, color: '#34d399' },
    { key: 'beta', label: 'Beta', symbol: 'β', low: 13, high: 30, color: '#fbbf24' },
    { key: 'gamma', label: 'Gamma', symbol: 'γ', low: 30, high: 45, color: '#f472b6' }
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

export function smoothAutoScale(previous: number | undefined, target: number): number {
  if (typeof previous !== 'number' || !Number.isFinite(previous) || previous <= 0) return target;
  if (target >= previous) return target;
  return Math.max(target, previous * 0.92);
}

export function downsampleTimedValues(values: TimedValue[], maxPoints: number): TimedValue[] {
  const limit = Math.floor(maxPoints);
  if (limit <= 0) return [];
  if (values.length <= limit) return values;
  if (limit === 1) return [values[values.length - 1]];
  if (limit === 2) return [values[0], values[values.length - 1]];

  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const bucketSize = (values.length - 2) / bucketCount;
  const result: TimedValue[] = [values[0]];

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor(bucket * bucketSize);
    const end = bucket === bucketCount - 1
      ? values.length - 1
      : Math.min(values.length - 1, 1 + Math.floor((bucket + 1) * bucketSize));
    if (start >= end) continue;

    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (values[index].value < values[minIndex].value) minIndex = index;
      if (values[index].value > values[maxIndex].value) maxIndex = index;
    }

    if (minIndex < maxIndex) {
      pushUnique(result, values[minIndex]);
      pushUnique(result, values[maxIndex]);
    } else {
      pushUnique(result, values[maxIndex]);
      pushUnique(result, values[minIndex]);
    }
  }

  pushUnique(result, values[values.length - 1]);
  return result.length <= limit ? result : result.slice(result.length - limit);
}

function pushUnique(values: TimedValue[], value: TimedValue): void {
  if (values[values.length - 1] !== value) values.push(value);
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

  static lowpass(cutoff: number, sampleRate: number, q: number): Biquad {
    const omega = (2 * Math.PI * cutoff) / sampleRate;
    const alpha = Math.sin(omega) / (2 * Math.max(q, 0.01));
    const cos = Math.cos(omega);
    const a0 = 1 + alpha;
    return new Biquad(
      ((1 - cos) / 2) / a0,
      (1 - cos) / a0,
      ((1 - cos) / 2) / a0,
      (-2 * cos) / a0,
      (1 - alpha) / a0
    );
  }

  static highpass(cutoff: number, sampleRate: number, q: number): Biquad {
    const omega = (2 * Math.PI * cutoff) / sampleRate;
    const alpha = Math.sin(omega) / (2 * Math.max(q, 0.01));
    const cos = Math.cos(omega);
    const a0 = 1 + alpha;
    return new Biquad(
      ((1 + cos) / 2) / a0,
      (-(1 + cos)) / a0,
      ((1 + cos) / 2) / a0,
      (-2 * cos) / a0,
      (1 - alpha) / a0
    );
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

// Butterworth 各阶数的级联 Q：最平坦通带设计，Q 由公式内部固定，对外不暴露
const BUTTERWORTH_STAGE_Q: Record<2 | 4, number[]> = {
  2: [Math.SQRT1_2],
  4: [0.541196100146197, 1.306562964876377]
};

// Kaiser 窗参数：β=8 → 阻带衰减约 -61dB，过渡带系数 Δω ≈ 3.3×2π/N
const KAISER_BETA = 8;
const KAISER_TRANSITION_COEFF = 3.3;
// FIR 抽头上限对应的最大群延迟（秒）：延迟 = (N-1)/2 个样本
const DEFAULT_MAX_DELAY_SECONDS = 4;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const y = (x * x) / 4;
  for (let k = 1; k < 64; k += 1) {
    term *= y / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

export interface FirBandpassOptions {
  low: number;
  high: number;
  sampleRate: number;
  /** 最大群延迟（秒），决定抽头上限；默认 4s，即 100Hz 下最多 801 抽头 */
  maxDelaySeconds?: number;
}

// 窗函数法（Kaiser）线性相位 FIR 带通设计。
// 过渡带宽度按低频边沿的 1/4 自适应（下限 0.2Hz）：边沿越低抽头越多、延迟越长，
// 但所有频带的延迟都被 maxDelaySeconds 封顶。增益在频带几何中心归一化为 1。
export function designFirBandpass({
  low,
  high,
  sampleRate,
  maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS
}: FirBandpassOptions): Float64Array {
  const nyquist = sampleRate / 2;
  const fLow = Math.max(0, Math.min(low, nyquist));
  const fHigh = Math.max(0, Math.min(high, nyquist));
  const maxTaps = Math.max(3, Math.floor(maxDelaySeconds * sampleRate) * 2 + 1);
  const transition = Math.max(0.2, fLow * 0.25);
  let taps = Math.ceil((KAISER_TRANSITION_COEFF * sampleRate) / transition);
  if (taps % 2 === 0) taps += 1;
  taps = Math.min(taps, maxTaps % 2 === 0 ? maxTaps - 1 : maxTaps);
  taps = Math.max(3, taps);

  const mid = (taps - 1) / 2;
  const windowDenom = besselI0(KAISER_BETA);
  const coeffs = new Float64Array(taps);
  for (let n = 0; n < taps; n += 1) {
    const m = n - mid;
    const lp = (cutoff: number) => {
      const fc = cutoff / sampleRate;
      return m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    };
    let ideal: number;
    if (fLow <= 0) {
      ideal = lp(fHigh);
    } else if (fHigh >= nyquist) {
      ideal = (n === Math.round(mid) ? 1 : 0) - lp(fLow);
    } else {
      ideal = lp(fHigh) - lp(fLow);
    }
    const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - (m / mid) ** 2))) / windowDenom;
    coeffs[n] = ideal * w;
  }

  // 频带中心增益归一化：LP 取半截止点、HP 取边沿与 Nyquist 中点、带通取几何中心
  const center = fLow <= 0
    ? fHigh / 2
    : fHigh >= nyquist
      ? (fLow + nyquist) / 2
      : Math.sqrt(fLow * fHigh);
  let re = 0;
  let im = 0;
  for (let n = 0; n < taps; n += 1) {
    const phase = (-2 * Math.PI * center * n) / sampleRate;
    re += coeffs[n] * Math.cos(phase);
    im += coeffs[n] * Math.sin(phase);
  }
  const gain = Math.hypot(re, im) || 1;
  for (let n = 0; n < taps; n += 1) coeffs[n] /= gain;
  return coeffs;
}

// 线性相位 FIR 滤波器：环形历史缓冲 + 直接卷积。
// 首个样本填充全部历史，消除启动阶跃瞬态（对带通而言等价于稳态初始化）。
export class FirFilter implements SampleProcessor {
  private readonly coeffs: Float64Array;
  private readonly history: Float64Array;
  private head = 0;
  private primed = false;

  constructor(coeffs: Float64Array) {
    this.coeffs = coeffs;
    this.history = new Float64Array(coeffs.length);
  }

  get delaySamples(): number {
    return (this.coeffs.length - 1) / 2;
  }

  process(input: number): number {
    if (!this.primed) {
      this.history.fill(input);
      this.primed = true;
    }
    this.history[this.head] = input;
    this.head = (this.head + 1) % this.coeffs.length;
    let acc = 0;
    let index = this.head;
    for (let k = 0; k < this.coeffs.length; k += 1) {
      index = index === 0 ? this.coeffs.length - 1 : index - 1;
      acc += this.coeffs[k] * this.history[index];
    }
    return acc;
  }

  reset(): void {
    this.history.fill(0);
    this.head = 0;
    this.primed = false;
  }
}

// 串接多个样本处理器形成滤波链，保持跨渲染状态，避免每帧重建带来的启动瞬态
export class FilterChain {
  private readonly stages: SampleProcessor[];
  constructor(stages: SampleProcessor[]) {
    this.stages = stages;
  }

  // Kaiser 窗 FIR 带通（+ 可选陷波）：幅频选择性最好的方案，群延迟按频带自适应
  // 且被 maxDelaySeconds 封顶（默认 4s）。延迟敏感的场景可用 butterworthBandpass。
  static firBandpass(opts: FirBandpassOptions & { notch?: 'off' | 50 | 60 }): FilterChain {
    const stages: SampleProcessor[] = [];
    if (opts.high > opts.low) {
      stages.push(new FirFilter(designFirBandpass(opts)));
    }
    if (opts.notch && opts.notch !== 'off') {
      stages.push(Biquad.notch(opts.notch, opts.sampleRate));
    }
    return new FilterChain(stages);
  }

  // Butterworth 带通：高通级 + 低通级级联（+ 可选陷波）。
  // 对外只需截止频率与每侧阶数（2 或 4），没有 Q 概念；阶数越高带外衰减越陡。
  static butterworthBandpass(opts: {
    low: number;
    high: number;
    sampleRate: number;
    order?: 2 | 4;
    notch?: 'off' | 50 | 60;
  }): FilterChain {
    const stages: Biquad[] = [];
    const stageQs = BUTTERWORTH_STAGE_Q[opts.order ?? 2];
    if (opts.low > 0 && opts.high > opts.low) {
      for (const q of stageQs) stages.push(Biquad.highpass(opts.low, opts.sampleRate, q));
    }
    if (opts.high > opts.low && opts.high < opts.sampleRate / 2) {
      for (const q of stageQs) stages.push(Biquad.lowpass(opts.high, opts.sampleRate, q));
    }
    if (opts.notch && opts.notch !== 'off') {
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

// 可增量处理的样本处理器：Biquad/Kalman 等状态ful滤波器都满足该结构
export interface SampleProcessor {
  process(input: number): number;
  reset(): void;
}

export class StreamingFilterCache {
  private key = '';
  private chain: SampleProcessor = new FilterChain([]);
  private outputs: TimedValue[] = [];

  update(key: string, values: TimedValue[], createChain: () => SampleProcessor): TimedValue[] {
    if (values.length === 0) {
      this.outputs = [];
      return [];
    }

    if (this.key !== key || this.shouldReset(values)) {
      this.key = key;
      this.chain = createChain();
      this.outputs = [];
    }

    const lastTimestamp = this.outputs[this.outputs.length - 1]?.timestamp ?? Number.NEGATIVE_INFINITY;
    for (const point of values) {
      if (point.timestamp <= lastTimestamp) continue;
      this.outputs.push({
        timestamp: point.timestamp,
        value: this.chain.process(point.value)
      });
    }

    const firstVisibleTimestamp = values[0].timestamp;
    const firstOutputIndex = this.outputs.findIndex((point) => point.timestamp >= firstVisibleTimestamp);
    if (firstOutputIndex > 0) {
      this.outputs = this.outputs.slice(firstOutputIndex);
    }

    return this.outputs.slice();
  }

  reset(): void {
    this.key = '';
    this.chain = new FilterChain([]);
    this.outputs = [];
  }

  private shouldReset(values: TimedValue[]): boolean {
    if (this.outputs.length === 0) return false;
    const firstInput = values[0].timestamp;
    const lastInput = values[values.length - 1].timestamp;
    const firstOutput = this.outputs[0].timestamp;
    const lastOutput = this.outputs[this.outputs.length - 1].timestamp;
    return lastInput < lastOutput || firstInput < firstOutput;
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
