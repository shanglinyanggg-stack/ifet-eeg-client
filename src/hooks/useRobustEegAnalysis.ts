import { useEffect,useMemo, useRef,useState,useSyncExternalStore } from 'react';
import { FilterChain, StreamingFilterCache, createEegBands, type TimedValue } from '../domain/dsp';
import { type ArtifactInterval } from '../domain/robust-eeg';
import {EegAnalysisClient} from '../domain/eeg-analysis-client';
import type { SleepDeltaArtifactContext } from '../domain/delta-artifact-filter';
import type { EegSettings } from '../domain/settings';

export function useRobustEegAnalysis(key:string,values:TimedValue[],sampleRate:number,settings:EegSettings,context?:SleepDeltaArtifactContext,active=true) {
  const [client]=useState(()=>new EegAnalysisClient());
  useEffect(()=>()=>client.dispose(),[client]);
  useEffect(()=>{if(active)client.submit(key,values,sampleRate,settings,context);},[active,client,context,key,sampleRate,settings.bandRanges,values]);
  return useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot);
}

export function useNativeBandWaveforms(key:string,values:TimedValue[],sampleRate:number,settings:EegSettings,intervals:ArtifactInterval[]) {
  const filters=useRef(createEegBands().map(()=>new StreamingFilterCache()));
  return useMemo(()=>{
    return createEegBands().map((band,index)=>{
      const range=settings.bandRanges[band.key];
      const filtered=filters.current[index].update(`${key}|${band.key}|${range.low}|${range.high}|${sampleRate}|${settings.notch}`,
        values,()=>{
          const chain=FilterChain.butterworthBandpass({...range,sampleRate,order:4,notch:settings.notch});
          let offset:number|null=null;
          return {process(value:number){offset??=value;return chain.process(value-offset);},reset(){chain.reset();offset=null;}};
        });
      return {label:band.label,color:band.color,values:filtered,range:`${range.low}–${range.high} Hz`};
    });
  },[key,sampleRate,settings.bandRanges,settings.notch,values]);
}
