import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { SleepMetrics } from '../domain/sleep-metrics';
import { SleepTrendChart } from './SleepTrendChart';

const metrics: SleepMetrics = {
  deltaRelative: 0.18,
  thetaRelative: 0.22,
  alphaRelative: 0.34,
  betaRelative: 0.26,
  thetaAlphaRatio: 0.65,
  sleepOnsetScore: 42,
  solTrend: 'transition',
  solSeconds: null,
  vertexWave: false,
  spindlePower: 0,
  spindleRelative: 0,
  spindleCandidate: false,
  kComplexCandidate: false,
  n2Candidate: false
};

afterEach(() => {
  cleanup();
});

describe('SleepTrendChart', () => {
  test('uses the clearer sleepiness wording for the score', () => {
    render(<SleepTrendChart metrics={metrics} />);

    expect(screen.getByLabelText('困意值')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '困意值' })).toBeInTheDocument();
    expect(screen.getByLabelText('困意值 42%，数值越高越困')).toBeInTheDocument();
  });
});
