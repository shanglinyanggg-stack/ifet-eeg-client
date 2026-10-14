import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,test,vi} from 'vitest';
import {defaultSettings} from '../domain/settings';
import {WorkbenchShell} from './WorkbenchShell';
afterEach(cleanup);
const props={view:'eeg' as const,settings:defaultSettings,settingsOpen:false,
  onViewChange:vi.fn(),onSettingsChange:vi.fn(),onSettingsOpen:vi.fn(),onCalibrationSettings:vi.fn(),
  settingsPanel:<div>settings fixture</div>,devicePanel:<div>device fixture</div>,
  connected:false,scanning:false,deviceName:'TD10',status:'待机',sampleRate:125,receivedRate:null,lossRate:null,sampleCount:0,
  batteryText:'—',recording:false,recordingPending:false,recordingSeconds:0,recordPath:'',onToggleRecording:vi.fn(),
  fullscreen:false,onFullscreen:vi.fn(),sleepPreventionActive:false,lslActive:false,children:<div>signals fixture</div>};
describe('research workbench information architecture',()=>{
  test('collapses navigation without touching recording or sample rate',()=>{
    const onSettingsChange=vi.fn();render(<WorkbenchShell {...props} onSettingsChange={onSettingsChange}/>);
    fireEvent.click(screen.getByRole('button',{name:'收起左侧栏'}));
    expect(onSettingsChange).toHaveBeenCalledWith({...defaultSettings,sidebarCollapsed:true});
    expect(screen.getByLabelText('脑电分析显示滤波开关')).toBeInTheDocument();
  });
  test('keeps six workspaces and one recording action in stable places',()=>{
    const onViewChange=vi.fn();render(<WorkbenchShell {...props} onViewChange={onViewChange}/>);
    const navigation=screen.getByLabelText('工作区导航');
    for(const name of ['脑电分析','数据采集','助眠引导','实验同步','调试模式','全部信号'])expect(within(navigation).getByRole('button',{name})).toBeInTheDocument();
    expect(screen.getAllByRole('button',{name:'开始记录'})).toHaveLength(1);
    fireEvent.click(within(navigation).getByRole('button',{name:'实验同步'}));expect(onViewChange).toHaveBeenCalledWith('sync');
  });
  test('unit switch requires confirmed hardware calibration',()=>{
    render(<WorkbenchShell {...props}/>);fireEvent.click(screen.getByLabelText('纵轴单位'));
    expect(screen.getByRole('option',{name:'µV · 需标定'})).toHaveAttribute('aria-disabled','true');
  });
  test('supports microvolts without changing acquisition settings',()=>{
    const onSettingsChange=vi.fn();const settings={...defaultSettings,signalDisplay:{...defaultSettings.signalDisplay,microvoltsPerCount:.5,calibrationConfirmed:true}};
    render(<WorkbenchShell {...props} settings={settings} onSettingsChange={onSettingsChange}/>);
    fireEvent.click(screen.getByLabelText('纵轴单位'));fireEvent.click(screen.getByRole('option',{name:'微伏 µV'}));
    const next=onSettingsChange.mock.calls[0][0];expect(next.signalDisplay.eegUnit).toBe('uv');
    expect(next.bleSampleRateHz).toBe(settings.bleSampleRateHz);expect(next.eeg).toEqual(settings.eeg);
  });
  test('device drawer does not resize or unmount the signal workspace',()=>{
    render(<WorkbenchShell {...props}/>);const signals=screen.getByText('signals fixture');
    fireEvent.click(screen.getByRole('button',{name:'设备连接与采样率'}));
    expect(screen.getByLabelText('连接工作台')).toBeInTheDocument();expect(screen.getByText('signals fixture')).toBe(signals);
  });
});
