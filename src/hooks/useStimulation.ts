import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { defaultStimulusConfig, initialStimulusStatus, stimulusStartReason, type StimulusConfig, type StimulusEvent, type StimulusStatus } from '../domain/stimulation';
export const stimulationNative = () => '__TAURI_INTERNALS__' in window;
export interface StimulusContext {
  connected: boolean; recording: boolean; acquisitionMode: boolean; demoMode: boolean; participantId: string;
  onEnterAcquisition: () => void; onActiveChange: (active: boolean) => void; onMarker: (event: StimulusEvent) => void;
}
export function useStimulation(props: StimulusContext) {
  const [config,setConfig]=useState<StimulusConfig>(defaultStimulusConfig);
  const [status,setStatus]=useState<StimulusStatus>(initialStimulusStatus);
  const [devices,setDevices]=useState<{audio:string[];serial:string[];monitors:string[]}>({audio:[],serial:[],monitors:[]});
  const [error,setError]=useState('');const [pending,setPending]=useState(false);
  const callback=useRef(props);callback.current=props;
  const update=useCallback((value:StimulusStatus)=>{if(typeof value?.active!=='boolean')return;setStatus(value);callback.current.onActiveChange(value.active);},[]);
  const refresh=useCallback(async()=>{
    if(!stimulationNative()){setError('请在原生上位机中选择刺激设备');return;}
    try{setDevices(await invoke('stimulus_devices'));setError('');}catch(e){setError(String(e));}
  },[]);
  useEffect(()=>{
    if(!stimulationNative())return;
    let cancelled=false;const unlisten:Array<()=>void>=[];
    const bind=async()=>{
      for(const promise of [listen<StimulusStatus>('stimulus://status',e=>update(e.payload)),listen<StimulusEvent>('stimulus://event',e=>callback.current.onMarker(e.payload))]){
        const stop=await promise;if(cancelled)stop();else unlisten.push(stop);
      }
      if(!cancelled){update(await invoke('stimulus_status'));await refresh();}
    };
    void bind().catch(e=>!cancelled&&setError(String(e)));
    const timer=window.setInterval(()=>{void invoke<StimulusStatus>('stimulus_status').then(update).catch(()=>undefined);},1000);
    return()=>{cancelled=true;window.clearInterval(timer);unlisten.forEach(stop=>stop());};
  },[refresh,update]);
  const stop=useCallback(async()=>{try{await invoke('stimulus_stop');}catch(e){setError(String(e));}},[]);
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'&&status.active){e.preventDefault();void stop();}};
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[status.active,stop]);
  const reason=stimulusStartReason(config,props);
  const start=async()=>{
    if(reason||pending||status.active||!stimulationNative())return;
    setPending(true);setError('');
    try{update(await invoke('stimulus_start',{config:{...config,participantId:props.participantId.trim()}}));}
    catch(e){setError(String(e));}finally{setPending(false);}
  };
  const choose=async()=>{
    if(!stimulationNative()){setError('请在原生上位机中导入 WAV');return;}
    try{const {open}=await import('@tauri-apps/plugin-dialog');
      const value=await open({multiple:false,directory:false,filters:[{name:'原始刺激 WAV',extensions:['wav']}]});
      if(typeof value==='string')setConfig(c=>({...c,wavPath:value,source:'wav'}));
    }catch(e){setError(String(e));}
  };
  const benchmark=async(modality:'sound'|'light')=>{
    if(pending||status.active||!stimulationNative())return;setPending(true);setError('');
    try{if(modality==='light')update(await invoke('stimulus_visual_benchmark'));else await invoke('stimulus_benchmark');}
    catch(e){setError(String(e));}finally{setPending(false);}
  };
  const resume=async()=>{try{await invoke('stimulus_resume');}catch(e){setError(String(e));}};
  return{config,setConfig,status,devices,error,pending,reason,start,stop,choose,refresh,benchmark,resume,
    enterAcquisition:props.onEnterAcquisition,acquisitionMode:props.acquisitionMode};
}
export type StimulationController=ReturnType<typeof useStimulation>;
