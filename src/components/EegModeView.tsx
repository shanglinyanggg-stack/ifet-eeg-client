import { useEffect, useMemo, useRef,useState } from 'react';
import { FilterChain, StreamingFilterCache, resolveScale, EEG_SAMPLE_RATE, type TimedValue } from '../domain/dsp';
import { spectralSleepMetrics, type RobustEegSnapshot } from '../domain/robust-eeg';
import type { SleepMetrics } from '../domain/sleep-metrics';
import type { SleepDeltaArtifactContext } from '../domain/delta-artifact-filter';
import type { EegChannel, EegSettings } from '../domain/settings';
import { useNativeBandWaveforms, useRobustEegAnalysis } from '../hooks/useRobustEegAnalysis';
import { WaveformCanvas } from './WaveformCanvas';
import { BandShareChart } from './BandShareChart';
import { SleepMetricsPanel } from './SleepMetricsPanel';
import { SleepTrendChart } from './SleepTrendChart';
import { SleepMusicPanel, resolveRealtimeStage, type SleepMusicPanelProps } from './SleepMusicPanel';
import {SpectrumChart} from './SpectrumChart';

interface EegModeViewProps {
  guidance?:boolean;
  channel:EegChannel;values:TimedValue[];fullAnalysisValues?:TimedValue[];settings:EegSettings;sampleRateHz?:number;
  onSleepMetrics?:(metrics:SleepMetrics)=>void;
  musicPanel?:Omit<SleepMusicPanelProps,'variant'|'metrics'>;
  deltaArtifactContext?:SleepDeltaArtifactContext;
}
export function EegModeView({guidance=false,channel,values,fullAnalysisValues,settings,sampleRateHz=EEG_SAMPLE_RATE,
  onSleepMetrics,musicPanel,deltaArtifactContext}:EegModeViewProps) {
  const analysis=useRobustEegAnalysis(channel,fullAnalysisValues??values,sampleRateHz,settings,deltaArtifactContext);
  const [bandLayout,setBandLayout]=useState<'grid'|'stack'>('grid');
  const bandSeries=useNativeBandWaveforms(channel,values,sampleRateHz,settings,analysis.artifactIntervals);
  const rawFilter=useRef(new StreamingFilterCache());
  const rawValues=useMemo(()=>{
    if(!settings.bandpassEnabled){rawFilter.current.reset();return values;}
    return rawFilter.current.update(`${channel}|${settings.bandpassLow}|${settings.bandpassHigh}|${settings.notch}|${sampleRateHz}`,values,
      ()=>FilterChain.butterworthBandpass({low:settings.bandpassLow,high:settings.bandpassHigh,sampleRate:sampleRateHz,order:2,notch:settings.notch}));
  },[channel,sampleRateHz,settings.bandpassEnabled,settings.bandpassHigh,settings.bandpassLow,settings.notch,values]);
  const metrics=useMemo(()=>spectralSleepMetrics(analysis),[analysis]);
  const staging=musicPanel?.serviceStatus?.lastResponse;
  const realtimeStage=resolveRealtimeStage(musicPanel?.serviceStatus?.phase,staging??null,musicPanel?.session);
  useEffect(()=>onSleepMetrics?.(metrics),[metrics,onSleepMetrics]);
  return <div className={`analysis-workspace ${guidance?'guidance-workspace':''}`}>
    <section className="analysis-waveforms" aria-label="脑电波形工作区">
      <div className="section-heading"><div><small>{guidance?'GUIDED REST / EEG':'LIVE EEG / FREQUENCY BANDS'}</small>
        <h2>{guidance?'助眠过程信号':'时域与频带分离'}</h2></div><span>{channel.toUpperCase()} · {sampleRateHz} Hz</span>
        <button className="text-tool" onClick={()=>setBandLayout(value=>value==='grid'?'stack':'grid')}>{bandLayout==='grid'?'纵向展开':'双列显示'}</button></div>
    <WaveformCanvas title={`${channel.toUpperCase()} ${settings.bandpassEnabled?`显示滤波 ${settings.bandpassLow}–${settings.bandpassHigh} Hz`:'原始波形（未滤波）'}`} series={[{label:channel.toUpperCase(),color:'var(--wave-raw)',
      values:rawValues,scale:resolveScale(settings.scale,rawValues.map(point=>point.value))}]} fill/>
    <div className="eeg-band-stack" data-layout={bandLayout} role="group" aria-label="频带分离">
      {bandSeries.map(band=><WaveformCanvas key={band.label} title={`${band.label} 频带`}
        sideLabel={{text:band.label,color:band.color,sub:band.range}} series={[band]}/>)}
    </div>
    </section>
    <aside className="analysis-inspector" aria-label={guidance?'助眠控制与基线':'频谱与状态'}>
      {guidance&&musicPanel&&<SleepMusicPanel {...musicPanel} metrics={metrics} variant="full"/>}
      <BandShareChart shares={analysis.displayShares??analysis.shares} colors={Object.fromEntries(bandSeries.map(band=>[band.label,band.color]))}
        mode={analysis.displayShares?'untrusted_preview':'welch_relative_power'} qualityLabel={analysisQualityLabel(analysis)}/>
      <section className="panel analysis-spectrum-panel"><div className="panel-header"><h2>实时功率谱</h2><span>{channel.toUpperCase()}</span></div>
        <SpectrumChart values={fullAnalysisValues??values} sampleRateHz={sampleRateHz} channelLabel={channel.toUpperCase()} analysis={analysis}/></section>
      <SleepTrendChart metrics={metrics} sleepProbability={staging?.decision_valid?staging.selected_sleep_probability:null}
        realtimeStage={realtimeStage} drowsinessMode={musicPanel?.settings.drowsinessMode}
        drowsinessEstimate={musicPanel?.drowsinessEstimate} onCalibrate={musicPanel?.onDrowsinessCalibration}/>
      <details className="panel secondary-metrics"><summary>频谱睡眠线索（非诊断）</summary><SleepMetricsPanel metrics={metrics}/></details>
    </aside>
  </div>;
}
export function analysisQualityLabel(analysis:RobustEegSnapshot):string {
  return `${analysis.reason} · 控制有效${Math.round(analysis.cleanFraction*100)}%${analysis.held&&!analysis.displayShares?' · 保持上次有效占比':''}`;
}
