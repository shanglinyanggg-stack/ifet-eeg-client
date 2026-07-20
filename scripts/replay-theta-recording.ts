import { readFileSync } from 'node:fs';
import { applyRobustMedianReference } from '../src/domain/eeg-reference';
import { createEegBands, FilterChain, type TimedValue } from '../src/domain/dsp';
import { matchedFilterSleepTheta } from '../src/domain/theta-matched-filter';

const recording = process.argv[2];
if (!recording) throw new Error('Usage: vite-node scripts/replay-theta-recording.ts <recording.csv>');

const rows = readFileSync(recording, 'utf8').trim().split(/\r?\n/);
const headers = rows.shift()?.split(',') ?? [];
const column = (name: string) => {
  const index = headers.indexOf(name);
  if (index < 0) throw new Error(`Missing CSV column: ${name}`);
  return index;
};
const indexes = Object.fromEntries(
  ['time', 'accX', 'accY', 'accZ', 'eeg1', 'eeg2', 'eeg3', 'eeg4']
    .map((name) => [name, column(name)])
);

const parsed = rows.map((row, rowIndex) => {
  const values = row.split(',');
  const timestamp = Date.parse(values[indexes.time]) || rowIndex * 10;
  return {
    timestamp,
    accX: Number(values[indexes.accX]),
    accY: Number(values[indexes.accY]),
    accZ: Number(values[indexes.accZ]),
    eeg1: signedU24(Number(values[indexes.eeg1])),
    eeg2: signedU24(Number(values[indexes.eeg2])),
    eeg3: signedU24(Number(values[indexes.eeg3])),
    eeg4: signedU24(Number(values[indexes.eeg4]))
  };
});
const timed = (key: keyof (typeof parsed)[number]): TimedValue[] => parsed.map((row) => ({
  timestamp: row.timestamp,
  value: Number(row[key])
}));
const channels = [timed('eeg1'), timed('eeg2'), timed('eeg3'), timed('eeg4')];
const contextChannels = channels.map((channel) => channel.slice(-1_200));
const context = {
  eegChannels: contextChannels,
  accelerometer: {
    x: timed('accX').slice(-1_200),
    y: timed('accY').slice(-1_200),
    z: timed('accZ').slice(-1_200)
  }
};

const results = channels.slice(0, 2).map((selected, index) => {
  const referenced = applyRobustMedianReference(selected, channels);
  const visibleRaw = referenced.slice(-1_200);
  const bandOutputs = createEegBands().map((band) => {
    const chain = FilterChain.firBandpass({
      low: band.low,
      high: band.high,
      sampleRate: 100,
      notch: 'off'
    });
    return {
      ...band,
      values: referenced.map((point) => ({ ...point, value: chain.process(point.value) })).slice(-1_200)
    };
  });
  const theta = bandOutputs.find((band) => band.key === 'theta');
  if (!theta) throw new Error('Theta band missing');
  const matched = matchedFilterSleepTheta(theta.values, visibleRaw, 100, context, {
    lowHz: theta.low,
    highHz: theta.high
  });
  const cleanedTheta = matched.values;
  const powersBefore = Object.fromEntries(bandOutputs.map((band) => [band.key, power(band.values)]));
  const powersAfter = { ...powersBefore, theta: power(cleanedTheta) };
  const changed = cleanedTheta.filter((point, sample) => point.value !== theta.values[sample].value).length;
  return {
    channel: `EEG${index + 1}`,
    thetaShareBefore: share(powersBefore.theta, powersBefore),
    thetaShareAfter: share(powersAfter.theta, powersAfter),
    thetaPowerReduction: percent(1 - powersAfter.theta / Math.max(powersBefore.theta, 1e-9)),
    samplesAttenuated: `${changed}/${cleanedTheta.length}`,
    rhythmicity: matched.rhythmicity.toFixed(3),
    retainedAmplitude: percent(matched.retainedFraction),
    artifactFraction: percent(matched.artifactFraction)
  };
});

console.table(results);

function signedU24(value: number): number {
  return value >= 0x800000 ? value - 0x1000000 : value;
}

function power(values: TimedValue[]): number {
  return values.reduce((sum, point) => sum + point.value ** 2, 0) / Math.max(1, values.length);
}

function share(value: number, values: Record<string, number>): string {
  const total = Object.values(values).reduce((sum, item) => sum + item, 0);
  return percent(value / Math.max(total, 1e-9));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
