import {useEffect,useState} from 'react';
import {SlidersHorizontal,X} from 'lucide-react';
import type {AppSettings} from '../domain/settings';
import {signalPageNames,type SignalPage} from '../domain/page-filters';
import {ThemedSelect} from './ThemedSelect';
export function PageSignalFilters({page,settings,onChange}:{page:SignalPage;settings:AppSettings;onChange:(settings:AppSettings)=>void}) {
  const [open,setOpen]=useState(false),filter=settings.pageFilters[page];
  useEffect(()=>setOpen(false),[page]);
  const update=(patch:Partial<typeof filter>)=>onChange({...settings,pageFilters:{...settings.pageFilters,[page]:{...filter,...patch}}});
  const preset=`${filter.low}-${filter.high}`;
  return <div className="page-filter-control">
    <label className="page-filter-switch"><input type="checkbox" checked={filter.enabled} aria-label={`${signalPageNames[page]}显示滤波开关`}
      onChange={event=>update({enabled:event.target.checked})}/><span>本页滤波</span></label>
    <button className="text-tool" aria-label={`${signalPageNames[page]}滤波参数`} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
      <SlidersHorizontal size={13}/>{filter.enabled?`${filter.low}–${filter.high} Hz`:'原始'}
    </button>
    {open&&<section className="page-filter-popover panel" aria-label={`${signalPageNames[page]}显示滤波参数`}>
      <header><strong>{signalPageNames[page]} · 显示滤波</strong><button className="toolbar-icon" aria-label="关闭滤波参数" onClick={()=>setOpen(false)}><X size={15}/></button></header>
      <label>预设<ThemedSelect ariaLabel="本页滤波预设" value={['0.5-30','8-13','0.7-15'].includes(preset)?preset:'custom'}
        options={[{value:'0.5-30',label:'常规EEG 0.5–30 Hz'},{value:'8-13',label:'Alpha 8–13 Hz'},{value:'0.7-15',label:'眨眼 0.7–15 Hz'},{value:'custom',label:'自定义'}]}
        onChange={value=>{if(value==='custom')return;const [low,high]=value.split('-').map(Number);update({low,high});}}/></label>
      <div className="two-col"><label>低频 Hz<input aria-label="本页滤波低频" type="number" min="0" max={filter.high-.1} step=".1" value={filter.low}
        onChange={event=>{const low=Number(event.target.value);if(low>=0&&low<filter.high)update({low});}}/></label>
        <label>高频 Hz<input aria-label="本页滤波高频" type="number" min={filter.low+.1} max="60" step=".1" value={filter.high}
          onChange={event=>{const high=Number(event.target.value);if(high>filter.low&&high<=60)update({high});}}/></label></div>
      <label>陷波<ThemedSelect ariaLabel="本页显示陷波" value={String(filter.notch)} options={[{value:'off',label:'关闭'},{value:'50',label:'50 Hz'},{value:'60',label:'60 Hz'}]}
        onChange={value=>update({notch:value==='off'?'off':Number(value) as 50|60})}/></label>
      {page==='normal'&&<><label><input type="checkbox" checked={filter.kalmanEnabled} onChange={event=>update({kalmanEnabled:event.target.checked})}/>卡尔曼平滑</label>
        <div className="two-col"><label>Q<input type="number" min=".01" step=".01" value={filter.kalmanQ} onChange={event=>update({kalmanQ:Number(event.target.value)})}/></label>
          <label>R<input type="number" min=".01" step=".1" value={filter.kalmanR} onChange={event=>update({kalmanR:Number(event.target.value)})}/></label></div></>}
      <small>仅作用于本页主波形，各页独立。四频带本身始终带通；不改变原始记录、LSL和控制算法。真实缺样处保留断线。</small>
    </section>}
  </div>;
}
