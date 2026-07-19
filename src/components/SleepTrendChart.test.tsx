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
    expect(screen.queryByRole('button', { name: '开始计算' })).not.toBeInTheDocument();
  });

  test('prefers the conservative staging probability and shows the realtime stage', () => {
    render(<SleepTrendChart metrics={metrics} sleepProbability={0.73} realtimeStage="NREM" />);

    expect(screen.getByLabelText('困意值 73%，数值越高越困')).toBeInTheDocument();
    expect(screen.getByText('NREM')).toBeInTheDocument();
    expect(screen.queryByText('未见')).not.toBeInTheDocument();
  });

  test('shows the wearable trial score and alert-baseline progress', () => {
    render(<SleepTrendChart
      metrics={metrics}
      drowsinessMode="wearable-trial"
      drowsinessEstimate={{
        score: 31,
        featureScore: null,
        modelScore: 35,
        baselineProgress: 0.5,
        baselineReady: false,
        qualityAccepted: true,
        source: 'alert-calibration',
        thetaBetaRatio: 0.5,
        slowFastRatio: 1.2,
        baselineThetaBetaRatio: 0.48
      }}
    />);

    expect(screen.getByLabelText('困意值 31%，数值越高越困')).toBeInTheDocument();
    expect(screen.getByText(/清醒基线 50%/)).toBeInTheDocument();
  });
});
