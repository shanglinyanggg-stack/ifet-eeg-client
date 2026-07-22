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
        selectedSampleRateHz={125}
        activeSampleRateHz={125}
        status="设备已连接"
        recordPath=""
        onSelectedDeviceChange={vi.fn()}
        onScan={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSelectedSampleRateChange={vi.fn()}
        onApplySampleRate={vi.fn()}
        onToggleRecording={vi.fn()}
      />
    );

    expect(screen.getByText('已连接：iFET Headset')).toBeInTheDocument();
    expect(screen.getByText('AA:BB:CC:DD · 设备已连接')).toBeInTheDocument();
    expect(screen.queryByLabelText('十六进制命令')).not.toBeInTheDocument();
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
        selectedSampleRateHz={500}
        activeSampleRateHz={250}
        status="正在持续扫描"
        recordPath=""
        onSelectedDeviceChange={vi.fn()}
        onScan={onScan}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSelectedSampleRateChange={vi.fn()}
        onApplySampleRate={vi.fn()}
        onToggleRecording={vi.fn()}
      />
    );

    const stopButton = screen.getByRole('button', { name: '停止扫描' });
    expect(stopButton).toBeEnabled();
    stopButton.click();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  test('exposes the FFF5 sample-rate command button', () => {
    const onApplySampleRate = vi.fn();
    render(
      <DevicePanel
        devices={[{ id: 'headset', name: 'TD10', rssi: -50 }]}
        connected
        scanning={false}
        recording={false}
        selectedDeviceId="headset"
        selectedSampleRateHz={1000}
        activeSampleRateHz={500}
        status="设备已连接"
        recordPath=""
        onSelectedDeviceChange={vi.fn()}
        onSelectedSampleRateChange={vi.fn()}
        onScan={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onApplySampleRate={onApplySampleRate}
        onToggleRecording={vi.fn()}
      />
    );

    expect(screen.getByRole('combobox', { name: 'BLE 采样率' })).toHaveTextContent('1 kHz · 72 04');
    screen.getByRole('button', { name: '设置采样率' }).click();
    expect(onApplySampleRate).toHaveBeenCalledTimes(1);
  });

  test('shows documented battery voltage and charging state', () => {
    render(
      <DevicePanel
        devices={[{ id: 'headset', name: 'TD10', rssi: -50 }]}
        connected
        scanning={false}
        recording={false}
        selectedDeviceId="headset"
        selectedSampleRateHz={125}
        activeSampleRateHz={125}
        batteryStatus={{
          timestamp: '2026-07-21T12:00:00Z',
          sequence: 8,
          charging: true,
          rawValue: 567,
          voltage: 4.2
        }}
        status="设备已连接"
        recordPath=""
        onSelectedDeviceChange={vi.fn()}
        onSelectedSampleRateChange={vi.fn()}
        onScan={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onApplySampleRate={vi.fn()}
        onToggleRecording={vi.fn()}
      />
    );

    expect(screen.getByLabelText('设备电量')).toHaveTextContent('4.20 V');
    expect(screen.getByLabelText('设备电量')).toHaveTextContent('正在充电');
  });

  test('shows live recording duration as HH:MM:SS', () => {
    render(
      <DevicePanel
        devices={[]}
        connected={false}
        scanning={false}
        recording
        recordingElapsedSeconds={3_723}
        selectedDeviceId=""
        selectedSampleRateHz={125}
        activeSampleRateHz={125}
        status="记录中"
        recordPath="/tmp/record.csv"
        onSelectedDeviceChange={vi.fn()}
        onSelectedSampleRateChange={vi.fn()}
        onScan={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onApplySampleRate={vi.fn()}
        onToggleRecording={vi.fn()}
      />
    );

    expect(screen.getByLabelText('数据记录时长')).toHaveTextContent('01:02:03');
  });
});
