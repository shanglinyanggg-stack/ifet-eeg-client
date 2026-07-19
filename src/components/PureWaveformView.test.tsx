import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings } from '../domain/settings';
import { PureWaveformView } from './PureWaveformView';

vi.mock('./WaveformCanvas', () => ({
  WaveformCanvas: ({
    title,
    series,
    sideLabel
  }: {
    title: string;
    series: unknown[];
    sideLabel?: { text: string };
  }) => (
    <section
      aria-label={title}
      data-testid="waveform"
      data-series-count={series.length}
      data-side-label={sideLabel?.text ?? ''}
    />
  )
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PureWaveformView', () => {
  test('replaces the lower-right overlay waveform with sleep EEG metrics', () => {
    const values = Array.from({ length: 80 }, (_, index) => ({
      timestamp: 1000 + index * 10,
      value: Math.sin(index / 3) * 18
    }));

    render(
      <PureWaveformView
        values={values}
        settings={{ ...defaultSettings, showChartsOnly: true, demoMode: true }}
        onChange={vi.fn()}
        onExit={vi.fn()}
        onToggleFullscreen={vi.fn()}
        connected={false}
        status="演示模式"
        sampleCount={values.length}
        warmupRemaining={0}
      />
    );

    const pureBands = screen.getAllByTestId('waveform').filter((chart) => chart.dataset.sideLabel);

    expect(pureBands).toHaveLength(4);
    expect(screen.queryByLabelText('原始 + 频带叠加')).not.toBeInTheDocument();
    expect(screen.getByLabelText('睡眠指标')).toBeInTheDocument();
    expect(screen.getByLabelText('困意值')).toBeInTheDocument();
    expect(screen.queryByLabelText('综合指标')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('睡眠指标')).getByText('θ/α 比值')).toBeInTheDocument();
  });
});
