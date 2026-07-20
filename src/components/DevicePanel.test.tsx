import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DevicePanel } from './DevicePanel';

afterEach(cleanup);

describe('DevicePanel connection identity', () => {
  test('shows the connected device name and identifier', () => {
    render(
      <DevicePanel
        devices={[{ id: 'AA:BB:CC:DD', name: 'iFET Headset', rssi: -48 }]}
        connected
        scanning={false}
        recording={false}
        selectedDeviceId="AA:BB:CC:DD"
        commandText=""
        status="设备已连接"
        recordPath=""
        onCommandTextChange={vi.fn()}
        onSelectedDeviceChange={vi.fn()}
        onScan={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSend={vi.fn()}
        onToggleRecording={vi.fn()}
      />
    );

    expect(screen.getByText('已连接：iFET Headset')).toBeInTheDocument();
    expect(screen.getByText('AA:BB:CC:DD · 设备已连接')).toBeInTheDocument();
  });

  test('lets the user stop an active continuous scan', () => {
    const onScan = vi.fn();
    render(
      <DevicePanel
        devices={[]}
        connected={false}
        scanning
        recording={false}
        selectedDeviceId=""
        commandText=""
        status="正在持续扫描"
        recordPath=""
        onCommandTextChange={vi.fn()}
        onSelectedDeviceChange={vi.fn()}
        onScan={onScan}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSend={vi.fn()}
        onToggleRecording={vi.fn()}
      />
    );

    const stopButton = screen.getByRole('button', { name: '停止扫描' });
    expect(stopButton).toBeEnabled();
    stopButton.click();
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});
