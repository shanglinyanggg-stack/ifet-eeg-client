import {useEffect,useState,type ReactNode} from 'react';
import {Activity,Bluetooth,BrainCircuit,Bug,ChevronDown,CircleStop,Database,Expand,FlaskConical,FolderOpen,Gauge,Maximize2,Minimize2,Moon,PanelLeftClose,PanelLeftOpen,Play,Settings2,ShieldCheck,SlidersHorizontal,Waves,X} from 'lucide-react';
import {PageSignalFilters} from './PageSignalFilters';
import type {AppSettings,AutoNumber,EegChannel} from '../domain/settings';
import {eegTimeWindowOptions} from '../domain/settings';
import {formatRecordingDuration} from '../domain/recording-time';
import {formatClockAxis,resolveMicrovoltsPerCount} from '../domain/signal-display';
import {ThemedSelect} from './ThemedSelect';
import {debugEegFilterOptions,type DebugEegFilterMode} from '../domain/debug-signal';
export type WorkbenchView='eeg'|'acquisition'|'sleep'|'sync'|'debug'|'normal';
const views=[
  {id:'eeg',label:'脑电分析',detail:'EEG & spectral',icon:BrainCircuit},
  {id:'acquisition',label:'数据采集',detail:'Record & annotate',icon:Database},
  {id:'sleep',label:'助眠引导',detail:'Sleep guidance',icon:Moon},
  {id:'sync',label:'实验同步',detail:'MATLAB & LSL',icon:FlaskConical},
  {id:'debug',label:'调试模式',detail:'Algorithm telemetry',icon:Bug},
  {id:'normal',label:'全部信号',detail:'EEG · PPG · motion',icon:Waves}
] as const;
interface Props {
  children:ReactNode;view:WorkbenchView;onViewChange:(view:WorkbenchView)=>void;
  settings:AppSettings;onSettingsChange:(settings:AppSettings)=>void;settingsOpen:boolean;onSettingsOpen:(open:boolean)=>void;
  settingsPanel:ReactNode;devicePanel:ReactNode;onCalibrationSettings:()=>void;
  connected:boolean;scanning:boolean;deviceName:string;status:string;sampleRate:number;receivedRate:number|null;lossRate:number|null;
  observedRate?:number|null;
  sampleCount:number;batteryText:string;recording:boolean;recordingPending:boolean;recordingSeconds:number;recordPath:string;
  onToggleRecording:()=>void;fullscreen:boolean;onFullscreen:()=>void;sleepPreventionActive:boolean;lslActive:boolean;
}
export function WorkbenchShell({children,view,onViewChange,settings,onSettingsChange,settingsOpen,onSettingsOpen,settingsPanel,
  devicePanel,onCalibrationSettings,connected,scanning,deviceName,status,sampleRate,receivedRate,observedRate,lossRate,sampleCount,batteryText,
  recording,recordingPending,recordingSeconds,recordPath,onToggleRecording,fullscreen,onFullscreen,sleepPreventionActive,lslActive}:Props){
  const [deviceOpen,setDeviceOpen]=useState(false),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const handler=(event:KeyboardEvent)=>{if(event.key!=='Escape')return;if(settingsOpen)onSettingsOpen(false);else if(deviceOpen)setDeviceOpen(false);};
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[deviceOpen,onSettingsOpen,settingsOpen]);
  const current=views.find(item=>item.id===view)??views[0],unit=settings.signalDisplay;
  const factor=resolveMicrovoltsPerCount(unit),microvolts=unit.eegUnit==='uv'&&factor!==null;
  const scaleOptions=(microvolts?[20,50,100,200,500]:[100,500,1000,2000,5000,10000,20000]).map(value=>({value:String(microvolts?value/factor!:value),label:`±${value} ${microvolts?'µV':'ADC'}`}));
  if(typeof settings.eeg.scale==='number'&&!scaleOptions.some(option=>Number(option.value)===settings.eeg.scale))
    scaleOptions.unshift({value:String(settings.eeg.scale),label:`±${(settings.eeg.scale*(microvolts?factor!:1)).toPrecision(3)} ${microvolts?'µV':'ADC'}`});
  const updateEeg=(patch:Partial<AppSettings['eeg']>)=>onSettingsChange({...settings,eeg:{...settings.eeg,...patch}});
  return <main className={`app-shell research-workbench ${settings.showChartsOnly?'is-focus':''} ${settings.sidebarCollapsed?'is-rail-collapsed':'is-rail-expanded'}`} data-theme={settings.theme}>
    <aside className="workbench-rail" aria-label="工作区导航">
      <div className="workbench-logo"><span><Activity size={24}/></span><div><strong>iFET</strong><small>RESEARCH STUDIO</small></div></div>
      <button className="rail-collapse-button" type="button" aria-label={settings.sidebarCollapsed?'展开左侧栏':'收起左侧栏'} aria-expanded={!settings.sidebarCollapsed}
        onClick={()=>onSettingsChange({...settings,sidebarCollapsed:!settings.sidebarCollapsed})}>
        {settings.sidebarCollapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}<span>收起导航</span></button>
      <div className="rail-label">工作区 / WORKSPACE</div>
      <nav>{views.map(item=><button key={item.id} type="button" className={view===item.id?'is-current':''}
        aria-current={view===item.id?'page':undefined} aria-label={item.label} title={item.label} onClick={()=>{setDeviceOpen(false);onSettingsOpen(false);onViewChange(item.id);}}>
        <item.icon size={19}/><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}</nav>
      <div className="rail-bottom"><ShieldCheck size={17}/><div><strong>MATLAB BRIDGE</strong><small>原始采集 · 可审计标记</small></div></div>
    </aside>
    <div className="workbench-main">
      <header className="workbench-header">
        <div className="workspace-title"><span className="workspace-eyebrow">iFET EEG CLIENT / MATLAB BRIDGE</span><h1>{current.label}</h1></div>
        <div className="workbench-header-actions">
          <button className={`connection-button ${connected?'is-connected':''}`} type="button" aria-expanded={deviceOpen}
            onClick={()=>{onSettingsOpen(false);setDeviceOpen(value=>!value);}} aria-label="设备连接与采样率">
            <Bluetooth size={17}/><span>{connected?deviceName:scanning?'扫描中…':'连接设备'}</span><ChevronDown size={13}/></button>
          <button type="button" className={`record-primary ${recording?'is-recording':''}`} onClick={onToggleRecording} disabled={recordingPending}>
            {recording?<CircleStop size={16}/>:<Play size={16}/>}<span>{recordingPending?'处理中…':recording?`停止记录 ${formatRecordingDuration(recordingSeconds)}`:'开始记录'}</span></button>
          <button type="button" className="toolbar-icon" aria-label={fullscreen?'退出全屏':'全屏'} title="全屏 · F11 / ⌃⌘F" onClick={onFullscreen}>
            {fullscreen?<Minimize2 size={18}/>:<Maximize2 size={18}/>}</button>
          <button type="button" className={`toolbar-icon ${settingsOpen?'is-active':''}`} aria-label="设置" aria-expanded={settingsOpen}
            onClick={()=>{setDeviceOpen(false);onSettingsOpen(!settingsOpen);}}><Settings2 size={19}/></button>
        </div>
      </header>
      <div className="acquisition-vitals" aria-label="采集状态概览">
        <div><span className={`live-dot ${connected||settings.demoMode?'is-live':''}`}/><strong>{connected?'设备在线':settings.demoMode?'模拟数据':'等待连接'}</strong></div>
        <div><span>信号时基</span><strong>{sampleRate===1000?'1 kHz':`${sampleRate} Hz`}</strong></div>
        <div><span>时基有效样本</span><strong>{receivedRate===null?'—':`${receivedRate.toFixed(1)} Hz`}</strong></div>
        <div data-alert={observedRate!=null&&observedRate<sampleRate*.8}><span>包内原始实收</span><strong>{observedRate==null?'—':`${observedRate.toFixed(1)} Hz`}</strong></div>
        <div data-alert={lossRate!==null&&lossRate>5}><span>目标样本缺额</span><strong>{lossRate===null?'—':`${lossRate.toFixed(1)}%`}</strong></div>
        <div><span>设备电量</span><strong>{batteryText}</strong></div>
        <button type="button" className={`data-mode-pill ${settings.acquisitionMode?'is-active':''}`} aria-label="数据采集模式"
          aria-pressed={settings.acquisitionMode} title="开启后停用音乐、基线、分期与眨眼算法"
          onClick={()=>{onSettingsChange({...settings,acquisitionMode:!settings.acquisitionMode,showChartsOnly:false});if(!settings.acquisitionMode)onViewChange('acquisition');}}>
          <ShieldCheck size={13}/>{settings.acquisitionMode?'仅采集 · 算法停用':'实时算法已启用'}</button>
      </div>
      <div className="signal-commandbar" aria-label="信号显示工具">
        <PageSignalFilters page={view} settings={settings} onChange={onSettingsChange}/>
        {(view==='eeg'||view==='sleep')&&<label><span>通道</span><ThemedSelect ariaLabel="分析EEG通道" value={settings.eeg.selectedChannel}
          options={['eeg1','eeg2','eeg3','eeg4'].map(value=>({value,label:value.toUpperCase()}))} onChange={value=>updateEeg({selectedChannel:value as EegChannel})}/></label>}
        <label><span>时间窗</span><ThemedSelect ariaLabel="显示时间窗" value={String(settings.eeg.timeWindowSeconds)} options={eegTimeWindowOptions}
          onChange={value=>updateEeg({timeWindowSeconds:value==='auto'?'auto':Number(value) as AutoNumber})}/></label>
        <label><span>纵轴</span><ThemedSelect ariaLabel="纵轴单位" value={microvolts?'uv':'adc'}
          options={[{value:'adc',label:'ADC计数'},{value:'uv',label:factor===null?'µV · 需标定':'微伏 µV',disabled:factor===null}]}
          onChange={value=>onSettingsChange({...settings,signalDisplay:{...unit,eegUnit:value==='uv'?'uv':'adc'}})}/></label>
        <label><span>量程</span><ThemedSelect ariaLabel="全局EEG量程" value={String(settings.eeg.scale)} options={[{value:'auto',label:'自动'},...scaleOptions]}
          onChange={value=>updateEeg({scale:value==='auto'?'auto':Number(value)})}/></label>
        <label><span>时间轴</span><ThemedSelect ariaLabel="时间轴格式" value={unit.timeAxis} options={[{value:'clock',label:'本地时刻'},{value:'relative',label:'相对当前'}]}
          onChange={value=>onSettingsChange({...settings,signalDisplay:{...unit,timeAxis:value as typeof unit.timeAxis}})}/></label>
        <button type="button" className="text-tool" onClick={onCalibrationSettings}><Gauge size={14}/>{factor===null?'电压标定':'标定参数'}</button>
        <button type="button" className="text-tool focus-tool" aria-pressed={settings.showChartsOnly} disabled={settings.acquisitionMode}
          onClick={()=>onSettingsChange({...settings,showChartsOnly:!settings.showChartsOnly})}><Expand size={14}/>{settings.showChartsOnly?'退出专注':'专注视图'}</button>
      </div>
      <section className="workbench-content" data-view={view}>{children}</section>
      <footer className="workbench-footer"><span className="footer-status" title={status}>{settings.demoMode?'演示 / 非真实采集':status}</span>
        <span><Activity size={12}/>{sampleCount.toLocaleString()} samples</span><span><ShieldCheck size={12}/>{sleepPreventionActive?'防休眠保护':'待机'}</span>
        <span>{lslActive?'LSL · 发布中':'LSL · 关闭'}</span><time>{formatClockAxis(now)}</time>
        {recording&&<span className="record-path" title={recordPath}><FolderOpen size={12}/>{recordPath.split(/[\\/]/).pop()}</span>}</footer>
    </div>
    {deviceOpen&&<><button className="drawer-backdrop" aria-label="关闭设备面板" onClick={()=>setDeviceOpen(false)}/>
      <aside className="workbench-drawer connection-drawer" aria-label="连接工作台"><header><div><small>ACQUISITION HARDWARE</small><h2>设备与采样</h2></div>
        <button type="button" className="toolbar-icon" aria-label="关闭设备面板" onClick={()=>setDeviceOpen(false)}><X size={18}/></button></header>{devicePanel}</aside></>}
    {settingsOpen&&<><button className="drawer-backdrop" aria-label="关闭设置背景" onClick={()=>onSettingsOpen(false)}/>
      <aside className="workbench-drawer settings-drawer" aria-label="设置工作台"><header><div><small>CONFIGURATION</small><h2>工作台设置</h2></div>
        <button type="button" className="toolbar-icon" aria-label="关闭设置" onClick={()=>onSettingsOpen(false)}><X size={18}/></button></header>{settingsPanel}</aside></>}
  </main>;
}
