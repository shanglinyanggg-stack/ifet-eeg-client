import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WaveformCanvas } from './WaveformCanvas';

type DrawCommand = {
  name: string;
  args: number[];
};

let drawCommands: DrawCommand[] = [];

const canvasContext = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  fillRect: vi.fn(),
  beginPath: vi.fn(() => drawCommands.push({ name: 'beginPath', args: [] })),
  moveTo: vi.fn((x: number, y: number) => drawCommands.push({ name: 'moveTo', args: [x, y] })),
  lineTo: vi.fn((x: number, y: number) => drawCommands.push({ name: 'lineTo', args: [x, y] })),
  stroke: vi.fn(),
  fillText: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  arcTo: vi.fn(),
  closePath: vi.fn(() => drawCommands.push({ name: 'closePath', args: [] })),
  fill: vi.fn(() => drawCommands.push({ name: 'fill', args: [] })),
  measureText: vi.fn((text: string) => ({ width: text.length * 7 }))
};

let pendingFrames: FrameRequestCallback[] = [];

function installCanvasMocks() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 320,
    bottom: 160,
    width: 320,
    height: 160,
    toJSON: () => ({})
  } as DOMRect);
}

beforeEach(() => {
  vi.clearAllMocks();
  drawCommands = [];
  installCanvasMocks();
  let frameId = 0;
  pendingFrames = [];
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      frameId += 1;
      pendingFrames.push(callback);
      return frameId;
    })
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function flushAnimationFrames() {
  const frames = pendingFrames;
  pendingFrames = [];
  frames.forEach((callback, index) => callback(index + 1));
}

function commandsForFirstFillPath() {
  const fillIndex = drawCommands.findIndex((command) => command.name === 'fill');
  let beginIndex = -1;
  for (let index = fillIndex - 1; index >= 0; index -= 1) {
    if (drawCommands[index].name === 'beginPath') {
      beginIndex = index;
      break;
    }
  }
  return drawCommands.slice(beginIndex, fillIndex + 1);
}

describe('WaveformCanvas', () => {
  test('redraws when incoming series values change', async () => {
    const initialSeries = [
      {
        label: 'EEG1',
        color: '#67e8f9',
        values: [
          { timestamp: 1000, value: 1 },
          { timestamp: 1010, value: 2 }
        ]
      }
    ];
    const nextSeries = [
      {
        label: 'EEG1',
        color: '#67e8f9',
        values: [
          { timestamp: 1000, value: 1 },
          { timestamp: 1010, value: 2 },
          { timestamp: 1020, value: 3 }
        ]
      }
    ];

    const { rerender } = render(<WaveformCanvas title="EEG1" series={initialSeries} />);

    await waitFor(() => expect(window.requestAnimationFrame).toHaveBeenCalled());
    act(() => flushAnimationFrames());
    const drawRequestsAfterInitialRender = vi.mocked(window.requestAnimationFrame).mock.calls.length;

    rerender(<WaveformCanvas title="EEG1" series={nextSeries} />);

    await waitFor(() => {
      expect(vi.mocked(window.requestAnimationFrame).mock.calls.length).toBeGreaterThan(
        drawRequestsAfterInitialRender
      );
    });
  });

  test('draws a visible shadow fill under waveform curves', async () => {
    const series = [
      {
        label: 'EEG1',
        color: '#67e8f9',
        values: [
          { timestamp: 1000, value: -1 },
          { timestamp: 1010, value: 3 },
          { timestamp: 1020, value: -2 }
        ]
      }
    ];

    render(<WaveformCanvas title="EEG1" series={series} />);

    await waitFor(() => expect(window.requestAnimationFrame).toHaveBeenCalled());
    act(() => flushAnimationFrames());

    expect(canvasContext.createLinearGradient).toHaveBeenCalledTimes(2);
    expect(canvasContext.fill).toHaveBeenCalled();
  });

  test('fills waveform shadow down to the lower axis without a diagonal wedge', async () => {
    const series = [
      {
        label: 'EEG1',
        color: '#67e8f9',
        values: [
          { timestamp: 1000, value: -1 },
          { timestamp: 1010, value: 3 },
          { timestamp: 1020, value: -2 }
        ]
      }
    ];

    render(<WaveformCanvas title="EEG1" series={series} />);

    await waitFor(() => expect(window.requestAnimationFrame).toHaveBeenCalled());
    act(() => flushAnimationFrames());

    const fillPath = commandsForFirstFillPath();

    expect(fillPath[0]?.name).toBe('beginPath');
    expect(fillPath[1]?.name).toBe('moveTo');
    expect(fillPath[1]?.args[1]).not.toBe(160);
    expect(fillPath[2]?.name).toBe('lineTo');
    expect(fillPath.filter((command) => command.name === 'moveTo')).toHaveLength(1);
    expect(fillPath.some((command) => command.name === 'lineTo' && command.args[0] === 320 && command.args[1] === 160)).toBe(true);
    expect(fillPath.some((command) => command.name === 'lineTo' && command.args[0] === 0 && command.args[1] === 160)).toBe(true);
  });
});
