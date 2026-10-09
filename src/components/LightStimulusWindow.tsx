import { useEffect,useRef,useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { chooseVisualClock,type ClockProbe } from '../domain/visual-stimulation';
import type { StimulusConfig } from '../domain/stimulation';
interface FrameCommand {runId:string;sequence:number;kind:string;label:string;brightness:number;scheduledTimeMs:number;block:number;trial:number}
export function LightStimulusWindow(){
  const canvas=useRef<HTMLCanvasElement>(null);const [message,setMessage]=useState('准备屏幕时钟…');
  useEffect(()=>{
    let disposed=false,raf=0,stopListener:(()=>void)|undefined,pending:FrameCommand|null=null,offset=0,uncertainty=0,runId='',lastFrame=0;
    const context=canvas.current?.getContext('2d',{alpha:false});if(!context)return;
    const draw=(brightness:number)=>{
      const element=canvas.current!;const scale=window.devicePixelRatio||1;
      if(element.width!==Math.round(window.innerWidth*scale)||element.height!==Math.round(window.innerHeight*scale)){
        element.width=Math.round(window.innerWidth*scale);element.height=Math.round(window.innerHeight*scale);
      }
      const value=Math.round(Math.max(0,Math.min(0.8,brightness))*255);context.fillStyle=`rgb(${value},${value},${value})`;
      context.fillRect(0,0,element.width,element.height);
    };
    draw(0);
    const frame=(time:number)=>{
      if(disposed)return;
      const interval=lastFrame?time-lastFrame:0;lastFrame=time;
      if(pending&&performance.now()+offset>=pending.scheduledTimeMs){
        const command=pending;pending=null;draw(command.brightness);const captured=performance.now()+offset;
        setMessage(`${command.label} · 第 ${command.block} 组 / 第 ${command.trial} 次 · Esc 停止`);
        void invoke('stimulus_visual_rendered',{value:{runId,sequence:command.sequence,capturedTimeMs:captured,
          frameIntervalMs:interval,clockUncertaintyMs:uncertainty}}).catch(e=>{setMessage(String(e));void invoke('stimulus_stop');});
      }
      raf=requestAnimationFrame(frame);
    };
    const start=async()=>{
      stopListener=await listen<FrameCommand>('stimulus://light-frame',event=>{
        if(event.payload.runId===runId){if(pending){setMessage('屏幕事件未完成，已请求停止');void invoke('stimulus_stop');}else pending=event.payload;}
      });
      if(disposed){stopListener();return;}
      const probes:ClockProbe[]=[];
      for(let i=0;i<5;i++){
        const sent=performance.now();const info=await invoke<{runId:string;config:StimulusConfig;hostTimeMs:number}>('stimulus_visual_clock');
        const received=performance.now();if(disposed)return;runId=info.runId;probes.push({clientSend:sent,clientReceive:received,hostTimeMs:info.hostTimeMs});
      }
      const mapping=chooseVisualClock(probes);offset=mapping.offsetMs;uncertainty=mapping.uncertaintyMs;
      raf=requestAnimationFrame(frame);setMessage('屏幕已就绪 · Esc 停止');await invoke('stimulus_visual_ready',{runId});
    };
    void start().catch(e=>{if(!disposed){setMessage(String(e));void invoke('stimulus_stop');}});
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();void invoke('stimulus_stop');}if(e.code==='Space'){e.preventDefault();void invoke('stimulus_resume').catch(()=>undefined);}};
    const visibility=()=>{if(document.hidden)void invoke('stimulus_stop');};
    window.addEventListener('keydown',key);document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;cancelAnimationFrame(raf);stopListener?.();window.removeEventListener('keydown',key);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  return <main className="light-stimulus-window"><canvas ref={canvas} aria-label="屏幕光刺激区域"/><div className="light-stimulus-caption">{message}</div></main>;
}
