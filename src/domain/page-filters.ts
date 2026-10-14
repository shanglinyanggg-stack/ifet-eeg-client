import type { AppSettings } from './settings';
import {FilterChain,KalmanFilter,type SampleProcessor} from './dsp';
export type SignalPage = 'eeg'|'sleep'|'acquisition'|'sync'|'debug'|'normal';
export interface PageFilter { enabled:boolean; low:number; high:number; notch:'off'|50|60; kalmanEnabled:boolean; kalmanQ:number; kalmanR:number }
export type PageFilters=Record<SignalPage,PageFilter>;
export function createPageDisplayProcessor(filter:PageFilter,rate:number):SampleProcessor {
  const chain=filter.enabled?FilterChain.butterworthBandpass({low:filter.low,high:filter.high,sampleRate:rate,order:2,notch:filter.notch}):null;
  const kalman=filter.enabled&&filter.kalmanEnabled?new KalmanFilter(filter.kalmanQ,filter.kalmanR):null;
  return {process(value){const filtered=chain?chain.process(value):value;return kalman?kalman.process(filtered):filtered;},reset(){chain?.reset();kalman?.reset();}};
}
export const signalPageNames:Record<SignalPage,string>={eeg:'脑电分析',sleep:'助眠引导',acquisition:'数据采集',sync:'实验同步',debug:'调试模式',normal:'全部信号'};
const base:PageFilter={enabled:false,low:.5,high:30,notch:'off',kalmanEnabled:false,kalmanQ:1,kalmanR:50};
export function defaultPageFilters():PageFilters {
  return {eeg:{...base},sleep:{...base},normal:{...base},acquisition:{...base,enabled:true},sync:{...base,enabled:true},debug:{...base,enabled:true}};
}
export function normalizePageFilters(value:Partial<PageFilters>|undefined,legacy?:Partial<AppSettings>):PageFilters {
  const defaults=defaultPageFilters();
  if(legacy?.eeg) for(const page of ['eeg','sleep'] as const) defaults[page]={...defaults[page],enabled:legacy.eeg.bandpassEnabled===true,
    low:legacy.eeg.bandpassLow??.5,high:legacy.eeg.bandpassHigh??30,notch:legacy.eeg.notch??'off'};
  if(legacy)defaults.normal={...defaults.normal,enabled:legacy.filterEnabled===true,low:legacy.filterLow??.5,high:legacy.filterHigh??30,
    kalmanEnabled:legacy.kalmanEnabled===true,kalmanQ:legacy.kalmanQ??1,kalmanR:legacy.kalmanR??50};
  for(const page of Object.keys(defaults) as SignalPage[]) {
    const item={...defaults[page],...value?.[page]};
    const low=Number.isFinite(item.low)&&item.low>=0&&item.low<60?item.low:.5;
    defaults[page]={...item,enabled:item.enabled===true,low,
      high:Number.isFinite(item.high)&&item.high>low&&item.high<=60?item.high:Math.max(30,low+.1),
      notch:item.notch===50||item.notch===60?item.notch:'off',kalmanEnabled:item.kalmanEnabled===true,
      kalmanQ:Number.isFinite(item.kalmanQ)&&item.kalmanQ>0?item.kalmanQ:1,kalmanR:Number.isFinite(item.kalmanR)&&item.kalmanR>0?item.kalmanR:50};
  }
  return defaults;
}
/** Display-only projection. Never applied to acquisition, recording, LSL or model inputs. */
export function settingsForSignalPage(settings:AppSettings,page:SignalPage):AppSettings {
  const filter=settings.pageFilters[page];
  return {...settings,filterEnabled:filter.enabled,filterLow:filter.low,filterHigh:filter.high,
    kalmanEnabled:filter.enabled&&filter.kalmanEnabled,kalmanQ:filter.kalmanQ,kalmanR:filter.kalmanR,
    eeg:{...settings.eeg,bandpassEnabled:filter.enabled,bandpassLow:filter.low,bandpassHigh:filter.high,notch:filter.enabled?filter.notch:'off'}};
}
