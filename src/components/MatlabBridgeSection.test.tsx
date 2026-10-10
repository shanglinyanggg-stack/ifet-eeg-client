import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { MatlabBridgeSection } from './MatlabBridgeSection';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const status = { running: false, connected: false, port: 45321, event_count: 0, active_stimuli: 0,
  last_event: '', last_receive_delay_ms: null, last_durable_delay_ms: null, clock_uncertainty_ms: null,
  event_path: '', csv_path: '', connection_path: '', last_error: '', alignment_pending: false, alignment_path: '' };
beforeEach(() => vi.mocked(invoke).mockResolvedValue(status));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
test('arms native reception without adding a stimulus generator', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'matlab_bridge_start'
    ? { ...status, running: true } : status);
  const prepare = vi.fn(); render(<MatlabBridgeSection onPrepare={prepare} />);
  fireEvent.click(screen.getByRole('button', { name: '开始接收' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('matlab_bridge_start', { port: 45321 }));
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('等待 MATLAB 连接')).toBeInTheDocument();
});
test('shows a recording prerequisite rejection instead of claiming reception', async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'matlab_bridge_start') throw new Error('请先开始 EEG 数据记录'); return status;
  });
  render(<MatlabBridgeSection />);fireEvent.click(screen.getByRole('button', { name: '开始接收' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请先开始 EEG 数据记录');
});
