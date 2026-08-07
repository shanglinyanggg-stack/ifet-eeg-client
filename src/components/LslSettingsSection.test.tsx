import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LslStatus } from '../domain/lsl';
import { defaultSettings } from '../domain/settings';
import { LslSettingsSection } from './LslSettingsSection';

afterEach(cleanup);

const runningStatus: LslStatus = {
  enabled: true,
  running: true,
  hasConsumers: true,
  message: 'LSL 接收端已连接',
  streamName: 'iFET-TD10',
  sourceId: 'ifet-td10-headset',
  sampleRateHz: 125,
  samplesPublished: 12_500,
  markersPublished: 3,
  droppedBatches: 0,
  protocolVersion: '1.10',
  libraryVersion: '1.13',
  lastError: null,
  streams: [{
    name: 'iFET-TD10_EEG',
    streamType: 'EEG',
    channelCount: 4,
    nominalSampleRateHz: 125,
    channelFormat: 'int32'
  }]
};

describe('LSL settings', () => {
  test('shows Chinese stream details and persists the enable switch', () => {
    const onChange = vi.fn();
    const onTestMarker = vi.fn();
    render(
      <LslSettingsSection
        settings={defaultSettings}
        status={runningStatus}
        onChange={onChange}
        onTestMarker={onTestMarker}
      />
    );

    expect(screen.getByText('Lab Streaming Layer')).toBeInTheDocument();
    expect(screen.getByText('iFET-TD10_EEG')).toBeInTheDocument();
    expect(screen.getByText('4 ch · 125 Hz · int32')).toBeInTheDocument();
    expect(screen.getByText('12,500')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('启用 LSL 实时输出'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      lsl: expect.objectContaining({ enabled: true })
    }));

    fireEvent.click(screen.getByRole('button', { name: '发送 LSL 测试标记' }));
    expect(onTestMarker).toHaveBeenCalledTimes(1);
  });
});
