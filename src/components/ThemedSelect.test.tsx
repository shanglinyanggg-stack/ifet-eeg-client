import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ThemedSelect } from './ThemedSelect';

const options = [
  { value: 'neuro-dark', label: 'Neuro Dark' },
  { value: 'clinical-light', label: 'Clinical Light' },
  { value: 'graphite', label: 'Graphite' }
];

afterEach(() => {
  cleanup();
});

describe('ThemedSelect', () => {
  test('shows the selected option label', () => {
    render(<ThemedSelect ariaLabel="界面主题" value="graphite" options={options} onChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: '界面主题' })).toHaveTextContent('Graphite');
  });

  test('opens themed options and selects a value', () => {
    const onChange = vi.fn();
    render(<ThemedSelect ariaLabel="界面主题" value="neuro-dark" options={options} onChange={onChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: '界面主题' }));
    expect(screen.getByRole('listbox', { name: '界面主题' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'Clinical Light' }));

    expect(onChange).toHaveBeenCalledWith('clinical-light');
    expect(screen.queryByRole('listbox', { name: '界面主题' })).not.toBeInTheDocument();
  });

  test('closes the menu with Escape', () => {
    render(<ThemedSelect ariaLabel="界面主题" value="neuro-dark" options={options} onChange={vi.fn()} />);

    const trigger = screen.getByRole('combobox', { name: '界面主题' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: '界面主题' })).not.toBeInTheDocument();
  });

  test('supports ArrowDown and Enter keyboard selection', () => {
    const onChange = vi.fn();
    render(<ThemedSelect ariaLabel="界面主题" value="neuro-dark" options={options} onChange={onChange} />);

    const trigger = screen.getByRole('combobox', { name: '界面主题' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('clinical-light');
  });
});
