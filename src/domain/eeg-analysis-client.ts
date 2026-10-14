import type {TimedValue} from './dsp';
import type {EegSettings} from './settings';
import type {SleepDeltaArtifactContext} from './delta-artifact-filter';
import {emptyRobustEegSnapshot,RobustEegAnalyzer,type RobustEegSnapshot} from './robust-eeg';
import {timeWindow} from './display-window';

export interface AnalysisRequest {
  id:number;key:string;values:TimedValue[];rate:number;ranges:EegSettings['bandRanges'];context?:SleepDeltaArtifactContext;
}
/** One in-flight request and one newest replacement per consumer. Requests are
 * capped at 1Hz and 9.5s of native data, never a growing UI/worker backlog. */
export class EegAnalysisClient {
  private worker:Worker|null=null;
  private fallback=new RobustEegAnalyzer();
  private requestId=0;
  private inFlight=false;
  private queued:AnalysisRequest|null=null;
  private lastKey='';private lastSubmittedMs=-Infinity;
  private snapshot=emptyRobustEegSnapshot();
  private listeners=new Set<()=>void>();
  private workerFailed=false;
  constructor(private createWorker=()=>new Worker(new URL('../workers/eeg-analysis.worker.ts',import.meta.url),{type:'module'})) {}
  private initializeWorker(){
    if(this.worker||this.workerFailed)return;
    if(typeof Worker!=='undefined')try{
      this.worker=this.createWorker();
      this.worker.onmessage=(event:MessageEvent<{id:number;snapshot:RobustEegSnapshot}>)=>{
        this.inFlight=false;
        if(event.data.id===this.requestId){this.snapshot={...event.data.snapshot,execution:'worker'};this.publish();}
        const next=this.queued;this.queued=null;if(next)this.send(next);
      };
      this.worker.onerror=()=>{this.worker?.terminate();this.worker=null;this.workerFailed=true;this.inFlight=false;
        const next=this.queued;this.queued=null;if(next)this.send(next);};
    }catch{this.worker=null;this.workerFailed=true;}
  }
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  submit(key:string,values:TimedValue[],rate:number,settings:EegSettings,context?:SleepDeltaArtifactContext){
    const last=values[values.length-1]?.timestamp??0;
    const signature=`${key}|${rate}|${JSON.stringify(settings.bandRanges)}`;
    if(signature===this.lastKey&&last>=this.lastSubmittedMs&&last-this.lastSubmittedMs<1000)return;
    this.lastKey=signature;this.lastSubmittedMs=last;
    const start=last-9500;
    const crop=(source:TimedValue[])=>timeWindow(source,start,last);
    const request:AnalysisRequest={id:++this.requestId,key,values:crop(values),rate,ranges:settings.bandRanges,
      context:context?{...context,eegChannels:[],accelerometer:context.accelerometer?{
        x:crop(context.accelerometer.x),y:crop(context.accelerometer.y),z:crop(context.accelerometer.z)}:undefined}:undefined};
    if(this.inFlight){this.queued=request;return;}this.send(request);
  }
  dispose(){this.worker?.terminate();this.worker=null;this.inFlight=false;this.queued=null;this.lastKey='';this.lastSubmittedMs=-Infinity;}
  private send(request:AnalysisRequest){
    this.initializeWorker();
    if(this.worker){this.inFlight=true;this.worker.postMessage(request);}
    else{this.snapshot={...this.fallback.update(request.key,request.values,request.rate,request.ranges,request.context),execution:'main-thread-fallback'};this.publish();}
  }
  private publish(){for(const listener of this.listeners)listener();}
}
