import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { BandShareChart } from './BandShareChart';

const shares = [
  { label: 'Delta' as const, value: 1, percent: 10 },
  { label: 'Theta' as const, value: 2, percent: 20 },
  { label: 'Alpha' as const, value: 3, percent: 30 },
  { label: 'Beta' as const, value: 4, percent: 40 }
];

const colors = {
  Delta: '#1d4ed8',
  Theta: '#7dd3fc',
  Alpha: '#f59e0b',
  Beta: '#ef4444'
};

afterEach(() => {
  cleanup();
});

describe('BandShareChart', () => {
  test('renders every EEG band as a compact legend item', () => {
    render(<BandShareChart shares={shares} colors={colors} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  test('labels state-enhanced shares as non-physical visual indices', () => {
    render(
      <BandShareChart
        shares={shares}
        colors={colors}
        mode="state_enhanced_visual_index"
        visualState="eyes_closed"
        visualConfidence={0.82}
      />
    );

    expect(screen.getByText('状态增强视觉占比')).toBeInTheDocument();
    expect(screen.getByText(/交互\/分期映射 · 非真实功率 · 闭眼增强 82%/)).toBeInTheDocument();
    expect(screen.getByText('视觉')).toBeInTheDocument();
  });
});
