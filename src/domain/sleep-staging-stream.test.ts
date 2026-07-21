import { describe, expect, test } from 'vitest';
import type { SampleEvent } from './protocol';
import { SleepDemoChunkAssembler, SleepStagingChunkAssembler } from './sleep-staging-stream';

function sample(sequence: number, eeg1 = 0x000101): SampleEvent {
  return {
    timestamp: new Date(1_700_000_000_000 + sequence * 8).toISOString(),
    packet: {
      sequence: sequence & 0xff,
      ppg: {
        ir1: 1,
        red1: 2,
        green1: 3,
        ir2: 4,
        red2: 5,
        green2: 6,
        accX: 11,
        accY: -12,
        accZ: 13
      },
      eeg: {
        eeg1,
        eeg2: 0x800001,
        eeg3: 0x7fffff,
        eeg4: 0xffffff
      }
    }
  };
}

describe('SleepStagingChunkAssembler', () => {
  test('emits exact 4x500 EEG and 3x500 IMU chunks', () => {
    const assembler = new SleepStagingChunkAssembler('session-one');
    const chunks = assembler.pushMany(Array.from({ length: 625 }, (_, index) => sample(index)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].session_id).toBe('session-one');
    expect(chunks[0].eeg_5s).toHaveLength(4);
    expect(chunks[0].eeg_5s.every((channel) => channel.length === 500)).toBe(true);
    expect(chunks[0].imu_5s).toHaveLength(3);
    expect(chunks[0].imu_5s.every((channel) => channel.length === 500)).toBe(true);
    expect(chunks[0].valid_5s.every(Boolean)).toBe(true);
  });

  test('converts unsigned U24 EEG to signed values only for the algorithm input', () => {
    const assembler = new SleepStagingChunkAssembler('session-signed');
    const chunk = assembler.pushMany(Array.from({ length: 625 }, (_, index) => sample(index)))[0];

    expect(chunk.eeg_5s[0][0]).toBe(0x000101);
    expect(chunk.eeg_5s[1][0]).toBe(-0x7fffff);
    expect(chunk.eeg_5s[2][0]).toBe(0x7fffff);
    expect(chunk.eeg_5s[3][0]).toBe(-1);
  });

  test('fills sequence gaps with invalid zero samples', () => {
    const assembler = new SleepStagingChunkAssembler('session-gap');
    const events = [sample(0), ...Array.from({ length: 623 }, (_, index) => sample(index + 2))];
    const chunk = assembler.pushMany(events)[0];

    expect(chunk.valid_5s).toHaveLength(500);
    expect(chunk.valid_5s[0]).toBe(true);
    expect(chunk.valid_5s[1]).toBe(false);
    expect(chunk.valid_5s[2]).toBe(true);
    expect(chunk.eeg_5s[0][1]).toBe(0);
    expect(chunk.imu_5s[0][1]).toBe(0);
  });

  test('ignores duplicated sequence numbers and resets with a new session', () => {
    const assembler = new SleepStagingChunkAssembler('session-old');
    assembler.push(sample(0));
    assembler.push(sample(0));
    expect(assembler.pendingSamples).toBe(1);

    assembler.reset('session-new');
    const chunks = assembler.pushMany(Array.from({ length: 625 }, (_, index) => sample(index)));
    expect(chunks[0].session_id).toBe('session-new');
  });
});

describe('SleepDemoChunkAssembler', () => {
  test('emits consecutive 500 ms chunks for the DemoSignalFlagger', () => {
    const assembler = new SleepDemoChunkAssembler('demo-session');
    const chunks = assembler.pushMany(Array.from({ length: 125 }, (_, index) => sample(index)));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].session_id).toBe('demo-session');
    expect(chunks[0].eeg.every((channel) => channel.length === 50)).toBe(true);
    expect(chunks[0].imu.every((channel) => channel.length === 50)).toBe(true);
    expect(chunks[0].valid).toHaveLength(50);
    expect(chunks[1].eeg[3][49]).toBe(-1);
  });

  test('keeps missing samples invalid in the 500 ms stream', () => {
    const assembler = new SleepDemoChunkAssembler('demo-gap');
    const events = [sample(0), ...Array.from({ length: 61 }, (_, index) => sample(index + 2))];
    const chunk = assembler.pushMany(events)[0];

    expect(chunk.valid[1]).toBe(false);
    expect(chunk.eeg[0][1]).toBe(0);
    expect(chunk.imu[0][1]).toBe(0);
  });

  test('preserves transport invalidity from the TD10 clock normalizer', () => {
    const assembler = new SleepDemoChunkAssembler('demo-transport-validity');
    const events = Array.from({ length: 63 }, (_, index) => ({
      ...sample(index),
      valid: index !== 15,
      deviceSequence: index
    }));
    const chunk = assembler.pushMany(events)[0];

    expect(chunk.valid[11]).toBe(true);
    expect(chunk.valid[12]).toBe(false);
    expect(chunk.eeg[0][12]).toBe(0);
    expect(chunk.imu[0][12]).toBe(0);
  });
});
