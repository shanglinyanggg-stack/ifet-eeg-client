import { AudioLines, FolderOpen, Play, RefreshCw, Square, Sun } from 'lucide-react';
import { stimulusPhaseLabels } from '../domain/stimulation';
import { stimulationNative, type StimulationController } from '../hooks/useStimulation';
const ms=(value:number|null)=>value==null?'—':`${value.toFixed(2)} ms`;
export function StimulationToolbar({controller:c,onOpenSettings}:{controller:StimulationController;onOpenSettings:()=>void}){
  return <div className="stimulus-toolbar" aria-label="刺激快捷控制">
    <button className="icon-button" type="button" onClick={onOpenSettings}><Sun size={17}/>刺激参数</button>
    {c.status.phase==='waiting-block'&&<button className="icon-button" type="button" onClick={()=>void c.resume()}>下一组</button>}
    <button className="icon-button stimulus-start" type="button" disabled={Boolean(c.reason)||c.status.active||c.pending||!stimulationNative()}
      title={c.reason??'开始并自动打标'} onClick={()=>void c.start()}><Play size={15}/>{c.pending?'准备中':`开始${c.config.modality==='light'?'光':'声'}刺激`}</button>
    <button className="icon-button stimulus-stop" type="button" disabled={!c.status.active} onClick={()=>void c.stop()}><Square size={15}/>停止刺激</button>
  </div>;
}
export function StimulationPanel({controller:c}:{controller:StimulationController}){
  const {config,status}=c;
  const number=(key:'durationSeconds'|'cueSeconds'|'restSeconds'|'trials'|'blocks',label:string,min:number,max:number,step:number)=><label>
    <span>{label}</span><input type="number" aria-label={label} value={config[key]} min={min} max={max} step={step}
      onChange={e=>c.setConfig(v=>({...v,[key]:Number(e.target.value)}))}/></label>;
  return <section className="stimulus-settings" aria-label="声光刺激设置">
    <div className="stimulus-settings-heading"><AudioLines size={17}/><strong>声光刺激实验</strong>
      <button type="button" disabled={status.active||c.pending} onClick={()=>void c.refresh()}><RefreshCw size={14}/>刷新设备</button></div>
    {!c.acquisitionMode&&<button type="button" disabled={status.active} onClick={c.enterAcquisition}>进入实验采集模式</button>}
    <fieldset className="stimulus-fields" disabled={status.active||c.pending}>
      <label><span>刺激类型</span><select aria-label="刺激类型" value={config.modality} onChange={e=>c.setConfig(v=>({...v,modality:e.target.value as 'sound'|'light'}))}>
        <option value="sound">声音刺激</option><option value="light">电脑屏幕光刺激</option></select></label>
      {config.modality==='sound'?<>
        <label><span>声音来源</span><select aria-label="刺激来源" value={config.source} onChange={e=>c.setConfig(v=>({...v,source:e.target.value as 'wav'|'test-tone'}))}>
          <option value="wav">导入原始刺激 WAV</option><option value="test-tone">1000 Hz 测试音</option></select></label>
        <label><span>刺激文件</span><button type="button" onClick={()=>void c.choose()}><FolderOpen size={14}/>{config.wavPath.split(/[\\/]/).pop()||'选择 WAV'}</button></label>
        <label><span>声音输出设备</span><select aria-label="刺激声音输出设备" value={config.audioDevice} onChange={e=>c.setConfig(v=>({...v,audioDevice:e.target.value}))}>
          <option value="">系统默认</option>{c.devices.audio.map(v=><option key={v} value={v}>{v.slice(v.indexOf('|')+1)}</option>)}</select></label>
        <label><span>刺激音量 {Math.round(config.volume*100)}%</span><input aria-label="刺激音量" type="range" min="0" max="0.8" step="0.01" value={config.volume}
          onChange={e=>c.setConfig(v=>({...v,volume:Number(e.target.value)}))}/></label>
      </>:<>
        <p className="stimulus-note">定时亮屏 → 暗屏；每次亮屏开始和结束自动打标。使用独立窗口，可移到另一显示器。</p>
        <label><span>刺激显示器</span><select aria-label="光刺激显示器" value={config.lightMonitor} onChange={e=>c.setConfig(v=>({...v,lightMonitor:e.target.value}))}>
          <option value="">主窗口所在显示器</option>{c.devices.monitors.map(v=><option key={v} value={v}>{v.slice(v.indexOf('|')+1)}</option>)}</select></label>
        <label><span>白色强度 {Math.round(config.lightBrightness*100)}%（绘制灰度）</span><input aria-label="光刺激白色强度" type="range" min="0.05" max="0.8" step="0.01" value={config.lightBrightness}
          onChange={e=>c.setConfig(v=>({...v,lightBrightness:Number(e.target.value)}))}/></label>
        <label className="stimulus-check"><input type="checkbox" checked={config.lightFullscreen} onChange={e=>c.setConfig(v=>({...v,lightFullscreen:e.target.checked}))}/>刺激窗口全屏</label>
        <p className="stimulus-note">同一屏幕全屏时会遮住上位机；需要同时观察 EEG 时使用窗口或第二块屏幕。系统亮度与色彩设置也会影响实际发光强度。</p>
      </>}
      {(config.modality==='light'||config.source==='test-tone')&&number('durationSeconds',config.modality==='light'?'亮屏时长 / 秒':'测试音时长 / 秒',0.05,120,0.1)}
      <div className="stimulus-pair">{number('cueSeconds','提示 / 秒',0.05,60,0.1)}{number('restSeconds','刺激间隔 / 秒',0.05,300,0.1)}</div>
      <div className="stimulus-pair">{number('trials','每组次数',1,100,1)}{number('blocks','组数',1,100,1)}</div>
      <label className="stimulus-check"><input type="checkbox" checked={config.pauseBetweenBlocks} onChange={e=>c.setConfig(v=>({...v,pauseBetweenBlocks:e.target.checked}))}/>组间等待手动继续</label>
      <label className="stimulus-check"><input type="checkbox" checked={config.serialEnabled} onChange={e=>c.setConfig(v=>({...v,serialEnabled:e.target.checked}))}/>启用 Arduino TTL</label>
      <label><span>串口 · 115200</span><select aria-label="刺激串口" disabled={!config.serialEnabled} value={config.serialPort} onChange={e=>c.setConfig(v=>({...v,serialPort:e.target.value}))}>
        <option value="">选择串口</option>{c.devices.serial.map(v=><option key={v}>{v}</option>)}</select></label>
      <label className="stimulus-check"><input type="checkbox" disabled={!config.serialEnabled} checked={config.serialOnOffset} onChange={e=>c.setConfig(v=>({...v,serialOnOffset:e.target.checked}))}/>结束也发送 T（起止同码）</label>
    </fieldset>
    <div className="stimulus-settings-status"><strong>{stimulusPhaseLabels[status.phase]??(status.phase||'待机')}</strong>
      <span>第 {status.block||'—'}/{status.totalBlocks||config.blocks} 组 · 第 {status.trial||'—'}/{status.totalTrials||config.trials} 次</span><span>已保存 {status.markerCount} 条事件</span>
      <span>派发延后 {ms(status.lastDispatchLatenessMs)}</span>{config.modality==='sound'&&<span>预测音频等待 {ms(status.lastAudioLeadMs)}</span>}
    </div>
    <p className="stimulus-message" role="status">{c.error||(status.active||['error','complete','aborted'].includes(status.phase)?status.message:c.reason||status.message)}</p>
    <div className="stimulus-test-buttons"><button type="button" disabled={status.active||c.pending||!stimulationNative()} onClick={()=>void c.benchmark('sound')}>静音音频时序自测</button>
      <button type="button" disabled={status.active||c.pending||!stimulationNative()} onClick={()=>void c.benchmark('light')}>全黑屏幕时序自测</button></div>
    {status.logPath&&<p className="stimulus-path">日志：{status.logPath}</p>}
    <p className="stimulus-note">起止事件写入当前 EEG 的 *_markers.csv。声音记录预测输出时刻，光刺激记录屏幕绘制请求时刻。实际发光时刻需光电传感器校准；屏幕光模式当前为定时亮灭，不提供高频闪烁。</p>
  </section>;
}
