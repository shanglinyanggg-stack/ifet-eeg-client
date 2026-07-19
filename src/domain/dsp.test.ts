import { describe, expect, test } from 'vitest';
import {
  FilterChain,
  FirFilter,
  StreamingFilterCache,
  appendSample,
  appendSamples,
  computeShare,
  createEegBands,
  designFirBandpass,
  downsampleTimedValues,
  resolveScale,
  smoothAutoScale
} from './dsp';

describe('frontend dsp helpers', () => {
  test('normalizes EEG band shares', () => {
    const share = computeShare([
      { label: 'Delta', value: 1 },
      { label: 'Theta', value: 2 },
      { label: 'Alpha', value: 3 },
      { label: 'Beta', value: 4 }
    ]);

    expect(share.map((item) => item.percent)).toEqual([10, 20, 30, 40]);
  });

  test('retains a sub-percent Delta residual for display', () => {
    const share = computeShare([
      { label: 'Delta', value: 2 },
      { label: 'Alpha', value: 998 }
    ]);

    expect(share.map((item) => item.percent)).toEqual([0.2, 99.8]);
  });

  test('resolves auto scale from visible values', () => {
    expect(resolveScale('auto', [-2, 4, 10])).toBe(12);
    expect(resolveScale(80, [-2, 4, 10])).toBe(80);
    expect(resolveScale('auto', [])).toBe(1);
  });

  test('smooths auto scale shrink while growing immediately', () => {
    expect(smoothAutoScale(undefined, 100)).toBe(100);
    expect(smoothAutoScale(50, 120)).toBe(120);
    expect(smoothAutoScale(100, 50)).toBeGreaterThan(50);
    expect(smoothAutoScale(100, 50)).toBeLessThan(100);
  });

  test('keeps sample buffers bounded', () => {
    const now = 1000;
    const first = appendSample([], { timestamp: now, value: 1 }, 3);
    const second = appendSample(first, { timestamp: now + 1, value: 2 }, 3);
    const third = appendSample(second, { timestamp: now + 2, value: 3 }, 3);
    const fourth = appendSample(third, { timestamp: now + 3, value: 4 }, 3);

    expect(fourth.map((sample) => sample.value)).toEqual([2, 3, 4]);
  });

  test('appends batched samples with one bounded copy', () => {
    const now = 1000;
    const current = [
      { timestamp: now, value: 1 },
      { timestamp: now + 1, value: 2 }
    ];
    const next = appendSamples(current, [
      { timestamp: now + 2, value: 3 },
      { timestamp: now + 3, value: 4 },
      { timestamp: now + 4, value: 5 }
    ], 4);

    expect(next.map((sample) => sample.value)).toEqual([2, 3, 4, 5]);
    expect(appendSamples(current, [], 4)).toBe(current);
  });

  test('creates four EEG bands with sleep EEG default ranges', () => {
    expect(createEegBands().map((band) => [band.label, band.low, band.high])).toEqual([
      ['Delta', 0.5, 2],
      ['Theta', 4, 7],
      ['Alpha', 8, 13],
      ['Beta', 13, 30]
    ]);
  });

  test('downsamples waveform points while keeping endpoints and peaks', () => {
    const values = Array.from({ length: 100 }, (_, index) => ({
      timestamp: 1000 + index,
      value: index === 20 ? 80 : index === 70 ? -60 : index
    }));

    const sampled = downsampleTimedValues(values, 20);

    expect(sampled.length).toBeLessThanOrEqual(20);
    expect(sampled[0]).toBe(values[0]);
    expect(sampled[sampled.length - 1]).toBe(values[values.length - 1]);
    expect(sampled.some((point) => point.value === 80)).toBe(true);
    expect(sampled.some((point) => point.value === -60)).toBe(true);
  });

  test('keeps filtered history stable when the same window is rendered again', () => {
    const cache = new StreamingFilterCache();
    const values = Array.from({ length: 80 }, (_, index) => ({
      timestamp: 1000 + index * 10,
      value: Math.sin(index / 3) * 20
    }));
    const createChain = () => FilterChain.butterworthBandpass({ low: 8, high: 13, sampleRate: 100, order: 4 });

    const first = cache.update('alpha', values, createChain);
    const second = cache.update('alpha', values, createChain);
    const extended = cache.update('alpha', [
      ...values,
      { timestamp: 1800, value: 3 },
      { timestamp: 1810, value: 6 }
    ], createChain);

    expect(second).toEqual(first);
    expect(extended.slice(0, first.length)).toEqual(first);
  });
});

describe('butterworth bandpass design', () => {
  // 测量稳态幅值响应：前 settle 个样本用于滤波器稳定
  function steadyAmplitude(chain: FilterChain, frequency: number, sampleRate = 100): number {
    const total = 6000;
    const settle = 3000;
    let peak = 0;
    for (let index = 0; index < total; index += 1) {
      const output = chain.process(Math.sin((2 * Math.PI * frequency * index) / sampleRate));
      if (index >= settle) peak = Math.max(peak, Math.abs(output));
    }
    return peak;
  }

  test('passes in-band signal and rejects out-of-band signal', () => {
    const alpha = () => FilterChain.butterworthBandpass({ low: 8, high: 13, sampleRate: 100, order: 4 });
    expect(steadyAmplitude(alpha(), 10)).toBeGreaterThan(0.7);
    expect(steadyAmplitude(alpha(), 20)).toBeLessThan(0.25);
    expect(steadyAmplitude(alpha(), 2)).toBeLessThan(0.05);
  });

  test('removes DC offset from wide bands', () => {
    const chain = FilterChain.butterworthBandpass({ low: 0.5, high: 5, sampleRate: 100, order: 2 });
    let output = 1;
    for (let index = 0; index < 4000; index += 1) output = chain.process(1);
    expect(Math.abs(output)).toBeLessThan(0.01);
  });

  test('higher order attenuates adjacent bands more strongly', () => {
    const order2 = FilterChain.butterworthBandpass({ low: 8, high: 13, sampleRate: 100, order: 2 });
    const order4 = FilterChain.butterworthBandpass({ low: 8, high: 13, sampleRate: 100, order: 4 });
    expect(steadyAmplitude(order4, 20)).toBeLessThan(steadyAmplitude(order2, 20));
  });
});

describe('fir bandpass design', () => {
  function steadyAmplitude(chain: FilterChain, frequency: number, sampleRate = 100): number {
    const total = 6000;
    const settle = 3000;
    let peak = 0;
    for (let index = 0; index < total; index += 1) {
      const output = chain.process(Math.sin((2 * Math.PI * frequency * index) / sampleRate));
      if (index >= settle) peak = Math.max(peak, Math.abs(output));
    }
    return peak;
  }

  test('passes in-band signal and strongly rejects out-of-band signal', () => {
    const alpha = () => FilterChain.firBandpass({ low: 8, high: 13, sampleRate: 100 });
    expect(steadyAmplitude(alpha(), 10)).toBeGreaterThan(0.9);
    expect(steadyAmplitude(alpha(), 20)).toBeLessThan(0.02);
    expect(steadyAmplitude(alpha(), 2)).toBeLessThan(0.02);
  });

  test('removes DC offset from the delta band', () => {
    const chain = FilterChain.firBandpass({ low: 0.5, high: 4, sampleRate: 100 });
    let output = 1;
    for (let index = 0; index < 4000; index += 1) output = chain.process(1);
    expect(Math.abs(output)).toBeLessThan(0.01);
  });

  test('caps group delay by maxDelaySeconds for low band edges', () => {
    const taps = designFirBandpass({ low: 0.5, high: 4, sampleRate: 100, maxDelaySeconds: 4 });
    expect(taps.length).toBeLessThanOrEqual(801);
    expect(taps.length % 2).toBe(1);
  });

  test('adapts tap count to band edge and centers impulse response', () => {
    const alphaTaps = designFirBandpass({ low: 8, high: 13, sampleRate: 100 });
    const deltaTaps = designFirBandpass({ low: 0.5, high: 4, sampleRate: 100 });
    expect(alphaTaps.length).toBeLessThan(deltaTaps.length);

    const filter = new FirFilter(alphaTaps);
    filter.process(0); // 以 0 预填充历史，避免首样本填充干扰脉冲响应
    let peakIndex = -1;
    let peakValue = 0;
    for (let index = 0; index < alphaTaps.length; index += 1) {
      const output = filter.process(index === 0 ? 1 : 0);
      if (Math.abs(output) > peakValue) {
        peakValue = Math.abs(output);
        peakIndex = index;
      }
    }
    expect(peakIndex).toBe((alphaTaps.length - 1) / 2);
  });
});
