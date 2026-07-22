import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings } from '../domain/settings';
import { AcquisitionModeView } from './AcquisitionModeView';

vi.mock('./WaveformCanvas', () => ({
  WaveformCanvas: ({ title, sideLabel }: { title: string; sideLabel?: { text: string } }) => (
    <section aria-label={title} data-side-label={sideLabel?.text ?? ''} />
  )
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
    const eegGroup = screen.getByLabelText('四通道原始 EEG');
    expect(eegGroup).toHaveClass('debug-waveforms');
    expect(within(eegGroup).getAllByLabelText(/EEG[1-4] · 显示 0.5–30 Hz/)).toHaveLength(4);

    const inspector = screen.getByLabelText('采集频带与事件标记');
    const bandCharts = within(inspector).getAllByLabelText(/Delta|Theta|Alpha|Beta/);
    expect(bandCharts).toHaveLength(4);
    expect(bandCharts.every((chart) => chart.dataset.sideLabel === '')).toBe(true);
    expect(within(inspector).getByLabelText('事件标记栏')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('采集频带分析通道'));
    fireEvent.click(screen.getByRole('option', { name: 'EEG3' }));
    expect(onSelectedChannelChange).toHaveBeenCalledWith('eeg3');

    fireEvent.click(screen.getByRole('button', { name: '运动伪迹' }));
    expect(onAddMarker).toHaveBeenCalledWith('运动伪迹', '');
  });
});
