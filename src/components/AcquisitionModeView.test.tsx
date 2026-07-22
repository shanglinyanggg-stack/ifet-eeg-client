import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings } from '../domain/settings';
import { AcquisitionModeView } from './AcquisitionModeView';

vi.mock('./WaveformCanvas', () => ({
  WaveformCanvas: ({ title }: { title: string }) => <section aria-label={title} />
}));

afterEach(cleanup);

describe('AcquisitionModeView', () => {
  test('keeps four EEG channels, selected-channel bands and manual markers', () => {
    const onSelectedChannelChange = vi.fn();
    const onAddMarker = vi.fn();
    render(
      <AcquisitionModeView
        eegBuffers={{ eeg1: [], eeg2: [], eeg3: [], eeg4: [] }}
        eegSettings={defaultSettings.eeg}
        connected
        deviceName="TD10"
        linkStatus="设备已连接"
        sampleCount={1_000}
        sampleRateHz={125}
        acquisitionSampleRateHz={1_000}
        invalidSampleCount={5}
        recording
        recordingPending={false}
        recordingElapsedSeconds={12}
        recordPath="/tmp/test.csv"
        markerPath="/tmp/test_markers.csv"
        markerStatus="可添加标记"
        markers={[]}
        blinkTrial={null}
        participantId="P001"
        onParticipantIdChange={vi.fn()}
        onSelectedChannelChange={onSelectedChannelChange}
        onToggleRecording={vi.fn()}
        onAddMarker={onAddMarker}
        onStartAlignment={vi.fn()}
      />
    );

    expect(screen.getByLabelText('数据采集模式界面')).toHaveTextContent('音乐、基线、分期和眨眼控制均已停用');
    expect(screen.getAllByLabelText(/EEG[1-4] · 采集波形/)).toHaveLength(4);
    expect(screen.getAllByLabelText(/Delta|Theta|Alpha|Beta/)).toHaveLength(4);

    fireEvent.click(screen.getByLabelText('采集频带分析通道'));
    fireEvent.click(screen.getByRole('option', { name: 'EEG3' }));
    expect(onSelectedChannelChange).toHaveBeenCalledWith('eeg3');

    fireEvent.click(screen.getByRole('button', { name: '运动伪迹' }));
    expect(onAddMarker).toHaveBeenCalledWith('运动伪迹', '');
  });
});
