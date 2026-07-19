import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings } from '../domain/settings';
import { EegModeView } from './EegModeView';

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
});

describe('EegModeView', () => {
  test('renders the lower-left EEG bands as four independent waveforms', () => {
    const values = Array.from({ length: 20 }, (_, index) => ({
      timestamp: 1000 + index * 10,
      value: Math.sin(index / 2) * 20
    }));

    render(<EegModeView channel="eeg1" values={values} settings={defaultSettings.eeg} />);

    const bandStack = screen.getByLabelText('频带分离');
    const bandCharts = within(bandStack).getAllByTestId('waveform');

    expect(bandCharts).toHaveLength(4);
    expect(bandCharts.map((chart) => chart.getAttribute('aria-label'))).toEqual([
      'Delta 频带',
      'Theta 频带',
      'Alpha 频带',
      'Beta 频带'
    ]);
    expect(bandCharts.every((chart) => chart.dataset.seriesCount === '1')).toBe(true);
    expect(screen.queryByLabelText('原始 + 频带')).not.toBeInTheDocument();
    expect(screen.getByLabelText('睡眠指标')).toBeInTheDocument();
    expect(screen.getByText('θ/α 比值')).toBeInTheDocument();
  });
});
