import { readFileSync } from 'node:fs';
import { applyRobustMedianReference } from '../src/domain/eeg-reference';
import { createEegBands, FilterChain, type TimedValue } from '../src/domain/dsp';
import { matchedFilterSleepTheta } from '../src/domain/theta-matched-filter';
import { compensateAwakeAperiodicSlope } from '../src/domain/band-share-compensation';

const recordings = process.argv.slice(2);
if (recordings.length === 0) {
  throw new Error('Usage: vite-node scripts/replay-awake-band-order.ts <recording.csv> [...]');
}

for (const recording of recordings) replay(recording);

function replay(recording: string): void {
  const rows = readFileSync(recording, 'utf8').trim().split(/\r?\n/);
  const headers = rows.shift()?.split(',') ?? [];
  const column = (name: string) => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`Missing CSV column: ${name}`);
    return index;
  };
  const indexes = Object.fromEntries(
    ['time', 'accX', 'accY', 'accZ', 'eeg1', 'eeg2', 'eeg3', 'eeg4'].map((name) => [name, column(name)])
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
  const timed = (key: 'eeg1' | 'eeg2' | 'eeg3' | 'eeg4'): TimedValue[] => parsed.map((row) => ({
    timestamp: row.timestamp,
    value: row[key]
  }));
  const channels = [timed('eeg1'), timed('eeg2'), timed('eeg3'), timed('eeg4')];
  const auxiliary = (key: 'accX' | 'accY' | 'accZ'): TimedValue[] => parsed.map((row) => ({
    timestamp: row.timestamp,
    value: row[key]
  }));
  const accelerometer = {
    x: auxiliary('accX'),
    y: auxiliary('accY'),
    z: auxiliary('accZ')
  };
  const summaries = channels.slice(0, 2).map((selected, channelIndex) => {
    const referenced = applyRobustMedianReference(selected, channels);
    const filtered = Object.fromEntries(createEegBands().map((band) => {
      const chain = FilterChain.firBandpass({
        low: band.low,
        high: band.high,
        sampleRate: 100,
        notch: 'off'
      });
      return [band.label, referenced.map((point) => ({ ...point, value: chain.process(point.value) }))];
    })) as Record<string, TimedValue[]>;
    const windowSize = Math.min(1_000, referenced.length);
    const start = Math.max(0, referenced.length - windowSize);
    const visibleRaw = referenced.slice(start);
    const thetaMatched = matchedFilterSleepTheta(
      filtered.Theta.slice(start),
      visibleRaw,
      100,
      {
        eegChannels: channels.map((channel) => channel.slice(start)),
        accelerometer: {
          x: accelerometer.x.slice(start),
          y: accelerometer.y.slice(start),
          z: accelerometer.z.slice(start)
        }
      },
      { lowHz: 4, highHz: 7 }
    );
    const amplitudes = Object.fromEntries(Object.entries(filtered).map(([label, values]) => [
      label,
      meanAbsolute(values.slice(start))
    ]));
    const shares = normalize(amplitudes);
    const corrected = normalize(Object.fromEntries(compensateAwakeAperiodicSlope([
      { label: 'Delta', value: amplitudes.Delta * 0.05, lowHz: 0.5, highHz: 2 },
      { label: 'Theta', value: meanAbsolute(thetaMatched.values), lowHz: 4, highHz: 7 },
      { label: 'Alpha', value: amplitudes.Alpha, lowHz: 8, highHz: 13 },
      { label: 'Beta', value: amplitudes.Beta, lowHz: 13, highHz: 30 }
    ], 'W 清醒').map((band) => [band.label, band.value])));
    const powers = normalize(Object.fromEntries(Object.entries(filtered).map(([label, values]) => [
      label,
      meanPower(values.slice(start))
    ])));
    const windowEnds = new Set<number>();
    for (let end = Math.min(1_000, referenced.length); end <= referenced.length; end += 500) {
      windowEnds.add(end);
    }
    windowEnds.add(referenced.length);
    let passedWindows = 0;
    const failedOrders = new Map<string, number>();
    for (const end of windowEnds) {
      const windowStart = Math.max(0, end - 1_000);
      const windowRaw = referenced.slice(windowStart, end);
      const windowTheta = matchedFilterSleepTheta(
        filtered.Theta.slice(windowStart, end),
        windowRaw,
        100,
        {
          eegChannels: channels.map((channel) => channel.slice(windowStart, end)),
          accelerometer: {
            x: accelerometer.x.slice(windowStart, end),
            y: accelerometer.y.slice(windowStart, end),
            z: accelerometer.z.slice(windowStart, end)
          }
        },
        { lowHz: 4, highHz: 7 }
      ).values;
      const windowCorrected = compensateAwakeAperiodicSlope([
        { label: 'Delta', value: meanAbsolute(filtered.Delta.slice(windowStart, end)) * 0.05, lowHz: 0.5, highHz: 2 },
        { label: 'Theta', value: meanAbsolute(windowTheta), lowHz: 4, highHz: 7 },
        { label: 'Alpha', value: meanAbsolute(filtered.Alpha.slice(windowStart, end)), lowHz: 8, highHz: 13 },
        { label: 'Beta', value: meanAbsolute(filtered.Beta.slice(windowStart, end)), lowHz: 13, highHz: 30 }
      ], 'W 清醒');
      const windowOrder = [...windowCorrected]
        .sort((left, right) => right.value - left.value)
        .map((band) => band.label)
        .join('>');
      if (windowOrder === 'Beta>Alpha>Theta>Delta') passedWindows += 1;
      else failedOrders.set(windowOrder, (failedOrders.get(windowOrder) ?? 0) + 1);
    }
    return {
      channel: `EEG${channelIndex + 1}`,
      Delta: format(shares.Delta),
      Theta: format(shares.Theta),
      Alpha: format(shares.Alpha),
      Beta: format(shares.Beta),
      order: Object.entries(shares).sort((left, right) => right[1] - left[1]).map(([label]) => label).join('>'),
      corrected: Object.entries(corrected).sort((left, right) => right[1] - left[1]).map(([label]) => label).join('>'),
      correctedShare: Object.entries(corrected).map(([label, value]) => `${label[0]}${(value * 100).toFixed(0)}`).join(' '),
      thetaRetained: format(thetaMatched.retainedFraction),
      awakeWindows: `${passedWindows}/${windowEnds.size}`,
      failedOrders: Array.from(failedOrders.entries()).map(([order, count]) => `${count}×${order}`).join('; ') || '--',
      powerOrder: Object.entries(powers).sort((left, right) => right[1] - left[1]).map(([label]) => label).join('>'),
      powerShare: Object.entries(powers).map(([label, value]) => `${label[0]}${(value * 100).toFixed(0)}`).join(' ')
    };
  });
  console.log(`\n${recording} (${parsed.length} samples)`);
  console.table(summaries);
}

function signedU24(value: number): number {
  return value >= 0x800000 ? value - 0x1000000 : value;
}

function meanAbsolute(values: TimedValue[]): number {
  return values.reduce((sum, point) => sum + Math.abs(point.value), 0) / Math.max(1, values.length);
}

function meanPower(values: TimedValue[]): number {
  return values.reduce((sum, point) => sum + point.value ** 2, 0) / Math.max(1, values.length);
}

function normalize(values: Record<string, number>): Record<string, number> {
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(values).map(([label, value]) => [label, value / Math.max(total, 1e-9)]));
}

function format(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
