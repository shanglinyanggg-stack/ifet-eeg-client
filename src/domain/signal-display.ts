export type SignalUnit='adc'|'uv';
export interface SignalDisplaySettings {
  eegUnit:SignalUnit;
  timeAxis:'clock'|'relative';
  calibrationMode:'coefficient'|'bipolar24';
  microvoltsPerCount:number|null;
  referenceVolts:number|null;
  totalGain:number|null;
  calibrationConfirmed:boolean;
  calibrationNote:string;
  interpolateGaps:boolean;
}
export const defaultSignalDisplay:SignalDisplaySettings={eegUnit:'adc',timeAxis:'clock',
  calibrationMode:'coefficient',microvoltsPerCount:null,referenceVolts:null,totalGain:null,
  calibrationConfirmed:false,calibrationNote:'',interpolateGaps:false};

export function resolveMicrovoltsPerCount(settings:SignalDisplaySettings):number|null {
  if(!settings.calibrationConfirmed)return null;
  const factor=settings.calibrationMode==='bipolar24'
    ? positive(settings.referenceVolts)&&positive(settings.totalGain)
      ? settings.referenceVolts!/settings.totalGain!/2**23*1e6:null
    : settings.microvoltsPerCount;
  return positive(factor)?factor!:null;
}
export function signalDisplayUnit(label:string,settings:SignalDisplaySettings):{label:string;factor:number;isEeg:boolean} {
  const isEeg=/^(EEG[1-4]|Delta|Theta|Alpha|Beta|Gamma)(\b|$)/i.test(label);
  const factor=resolveMicrovoltsPerCount(settings);
  return isEeg&&settings.eegUnit==='uv'&&factor!==null
    ? {label:'µV',factor,isEeg}:{label:/^ACC/i.test(label)?'ACC计数':'ADC',factor:1,isEeg};
}
export function normalizeSignalDisplay(value:Partial<SignalDisplaySettings>|undefined):SignalDisplaySettings {
  return {...defaultSignalDisplay,...value,eegUnit:value?.eegUnit==='uv'?'uv':'adc',
    timeAxis:value?.timeAxis==='relative'?'relative':'clock',
    calibrationMode:value?.calibrationMode==='bipolar24'?'bipolar24':'coefficient',
    microvoltsPerCount:positive(value?.microvoltsPerCount)?value!.microvoltsPerCount!:null,
    referenceVolts:positive(value?.referenceVolts)?value!.referenceVolts!:null,
    totalGain:positive(value?.totalGain)?value!.totalGain!:null,
    calibrationConfirmed:value?.calibrationConfirmed===true,
    interpolateGaps:value?.interpolateGaps===true,
    calibrationNote:typeof value?.calibrationNote==='string'?value.calibrationNote.slice(0,160):''};
}
function positive(value:unknown):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>0;}

export function formatAxisNumber(value:number):string {
  if(!Number.isFinite(value))return '—';
  const absolute=Math.abs(value);
  if(absolute>=100000)return `${(value/1000).toFixed(0)}k`;
  if(absolute>=1000)return `${(value/1000).toFixed(1).replace(/\.0$/,'')}k`;
  if(absolute>=10)return value.toFixed(0);
  if(absolute>=1)return value.toFixed(1).replace(/\.0$/,'');
  if(absolute===0)return '0';
  return value.toFixed(2);
}
export function formatClockAxis(timestamp:number,milliseconds=false):string {
  if(!Number.isFinite(timestamp))return '—';const date=new Date(timestamp);
  const pad=(value:number,length=2)=>String(value).padStart(length,'0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${milliseconds?`.${pad(date.getMilliseconds(),3)}`:''}`;
}
export function timeAxisTicks(start:number,end:number,width:number,mode:SignalDisplaySettings['timeAxis']) {
  const count=Math.max(2,Math.min(5,Math.floor(width/125)));
  return Array.from({length:count},(_,index)=>{
    const timestamp=start+(end-start)*index/(count-1);
    return {timestamp,fraction:index/(count-1),label:mode==='clock'?formatClockAxis(timestamp,end-start<5000):
      `${((timestamp-end)/1000).toFixed(end-start<5000?1:0)}s`};
  });
}
