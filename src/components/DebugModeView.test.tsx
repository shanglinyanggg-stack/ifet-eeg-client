import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSleepSessionState } from '../domain/sleep-session';
import { defaultSettings } from '../domain/settings';
import { DebugModeView } from './DebugModeView';

vi.mock('./WaveformCanvas', () => ({
  WaveformCanvas: ({ title }: { title: string }) => <section aria-label={title} />
}));

afterEach(() => cleanup());

const emptyEeg = { eeg1: [], eeg2: [], eeg3: [], eeg4: [] };
const emptyPpg = { ir1: [], red1: [], green1: [], ir2: [], red2: [], green2: [] };
const player = {
  selectedTrack: null,
  snapshot: {
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 0.6,
    fadeRemainingSeconds: 0,
    error: null,
    autoplayBlocked: false,
    outputDevices: [{ deviceId: 'default', label: '系统默认输出' }],
    selectedOutputDeviceId: 'default',
    outputDeviceSupported: false,
    outputDeviceError: null
  },
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  toggle: vi.fn(async () => undefined),
  previous: vi.fn(),
  next: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  refreshOutputDevices: vi.fn(async () => undefined),
  setOutputDevice: vi.fn(async () => true),
  testOutput: vi.fn(async () => undefined)
};

function props(recording = false) {
  return {
    eegBuffers: emptyEeg,
    ppgBuffers: emptyPpg,
    connected: true,
    deviceName: 'TD10',
    linkStatus: '已连接',
    sampleCount: 1000,
    invalidSampleCount: 20,
    latestDeviceFlag: 3,
    recording,
    recordPath: recording ? 'data.csv' : '',
    markerPath: recording ? 'data_markers.csv' : '',
    markerStatus: recording ? '标记已保存' : '请先开始记录',
    markers: [],
    algorithmEvents: [],
    algorithmAction: recording ? '3 次眨眼：降低音量' : null,
    demoResponse: null,
    demoPhase: 'ready',
    demoMessage: 'Alpha 在线',
    stagingResponse: null,
    stagingPhase: 'warming',
    stagingMessage: 'PC 算法预热',
    session: createSleepSessionState({
      baseVolume: 0.6,
      transitionVolume: 0.18,
      relaxAlphaThreshold: 0.32,
      fadeSleepScoreThreshold: 45,
      stopSleepScoreThreshold: 68,
      relaxConfirmSeconds: 2,
      transitionConfirmSeconds: 1,
      sleepConfirmSeconds: 3,
      awakeConfirmSeconds: 3,
      emaAlpha: 0.25,
      minimumCoverage: 0.6
    }),
    sleepSettings: defaultSettings.sleepMusic,
    player,
    guidanceActive: false,
    guidanceMessage: '等待开始助眠',
    blinkTrial: null,
    participantId: 'P001',
    onParticipantIdChange: vi.fn(),
    onSleepSettingsChange: vi.fn(),
    onOpenEyeCalibration: vi.fn(),
    onClosedEyeCalibration: vi.fn(),
    onBlinkCalibration: vi.fn(),
    onStartGuidance: vi.fn(),
    onStopGuidance: vi.fn(),
    onStartSleepAndRecord: vi.fn(),
    onStartBlinkValidation: vi.fn(),
    onStopSession: vi.fn(),
    onStartBlinkTrial: vi.fn(),
    onToggleRecording: vi.fn(),
    onAddMarker: vi.fn()
  };
}

describe('DebugModeView', () => {
  test('integrates EEGSleepUpper filters, PPG view and diagnostic sections', () => {
    render(<DebugModeView {...props()} />);

    expect(screen.getByText('EEGSleepUpper 综合调试')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '调试 EEG 显示滤波' })).toHaveTextContent('显示 0.5–30 Hz');
    expect(screen.getByText('Alpha 实时与个体双基线')).toBeInTheDocument();
    expect(screen.getByText('四通道配对眨眼诊断')).toBeInTheDocument();
    expect(screen.getByText('保守睡眠判定')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /6 路 PPG/ }));
    expect(screen.getByLabelText('PPG1 · AC 0.35–8 Hz · IR / Red / Green')).toBeInTheDocument();
    expect(screen.getByLabelText('PPG2 · AC 0.35–8 Hz · IR / Red / Green')).toBeInTheDocument();
  });

  test('enables truth trials and manual markers only while recording', () => {
    const idle = props(false);
    const { rerender } = render(<DebugModeView {...idle} />);
    expect(screen.getByRole('button', { name: '标记并测试 3 次' })).toBeDisabled();

    const active = props(true);
    rerender(<DebugModeView {...active} />);
    fireEvent.click(screen.getByRole('button', { name: '标记并测试 3 次' }));
    expect(active.onStartBlinkTrial).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: /单次眨眼/ }));
    expect(active.onAddMarker).toHaveBeenCalledWith('单次眨眼', '');
    expect(screen.getByText('3 次眨眼：降低音量')).toBeInTheDocument();
  });
});
