import { afterEach, describe, expect, test, vi } from 'vitest';
import { SampleBatcher } from './sample-batcher';

afterEach(() => {
  vi.useRealTimers();
});

describe('SampleBatcher', () => {
  test('coalesces high frequency events into one timed flush', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new SampleBatcher<string>({
      intervalMs: 50,
      onFlush: (items) => batches.push(items)
    });

    batcher.push('a');
    batcher.push('b');

    expect(batches).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(batches).toEqual([['a', 'b']]);
  });

  test('can flush pending events immediately', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const batcher = new SampleBatcher<number>({
      intervalMs: 50,
      onFlush: (items) => batches.push(items)
    });

    batcher.push(1);
    batcher.push(2);
    batcher.flush();
    vi.advanceTimersByTime(50);

    expect(batches).toEqual([[1, 2]]);
  });

  test('coalesces a native multi-sample BLE packet without per-sample scheduling', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const batcher = new SampleBatcher<number>({
      intervalMs: 100,
      onFlush: (items) => batches.push(items)
    });

    batcher.pushMany([1, 2, 3, 4, 5, 6, 7, 8]);
    vi.advanceTimersByTime(100);

    expect(batches).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
  });
});
