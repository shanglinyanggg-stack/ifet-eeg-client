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
  Delta: '#60a5fa',
  Theta: '#a78bfa',
  Alpha: '#22c55e',
  Beta: '#f59e0b'
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
});
