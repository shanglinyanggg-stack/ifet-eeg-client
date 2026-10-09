import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StimulationPanel, StimulationToolbar } from './StimulationPanel';
import { useStimulation, type StimulusContext } from '../hooks/useStimulation';

afterEach(cleanup);
const props = () => ({ connected: false, recording: false, acquisitionMode: false, demoMode: false,
  participantId: '', onEnterAcquisition: vi.fn(), onActiveChange: vi.fn(), onMarker: vi.fn() });
function Harness(p:StimulusContext){const controller=useStimulation(p);return <><StimulationToolbar controller={controller} onOpenSettings={vi.fn()}/><StimulationPanel controller={controller}/></>;}

describe('stimulation panel safety and layout', () => {
  test('browser preview cannot start hardware playback', () => {
    render(<Harness {...props()} connected recording acquisitionMode />);
    expect(screen.getByRole('button', { name: '开始声刺激' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '全黑屏幕时序自测' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止刺激' })).toBeDisabled();
    expect(screen.getByLabelText('刺激来源')).toHaveValue('wav');
  });
  test('parameters stay outside the waveform toolbar and light does not require a WAV', () => {
    render(<Harness {...props()} connected recording acquisitionMode />);
    expect(screen.getByLabelText('提示 / 秒')).toHaveValue(1);
    expect(within(screen.getByLabelText('刺激快捷控制')).queryByLabelText('提示 / 秒')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('刺激类型'),{target:{value:'light'}});
    expect(screen.getByLabelText('亮屏时长 / 秒')).toHaveValue(5);
    expect(screen.getByRole('button',{name:'开始光刺激'})).toHaveAttribute('title','开始并自动打标');
    expect(screen.queryByLabelText('刺激来源')).not.toBeInTheDocument();
  });
  test('requires explicit entry to acquisition mode', () => {
    const p = props(); render(<Harness {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '进入实验采集模式' }));
    expect(p.onEnterAcquisition).toHaveBeenCalledOnce();
    expect(screen.getByText(/停用助眠音乐与自动控制/)).toBeInTheDocument();
  });
});
