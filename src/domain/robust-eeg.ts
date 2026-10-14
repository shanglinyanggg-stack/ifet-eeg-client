import { createEegBands, type BandShare, type TimedValue } from './dsp';
import { fftInPlace, type PowerSpectrumSnapshot } from './power-spectrum';
import type { BandRange, EegBandKey } from './settings';
import type { SleepDeltaArtifactContext } from './delta-artifact-filter';
import { calculateSleepMetrics, type SleepMetrics } from './sleep-metrics';
import {timeWindow} from './display-window';

export const SPECTRAL_WINDOW_SECONDS = 8;
const PSD_RATE = 100;
const SEGMENT_SAMPLES = 400;
const FFT_SIZE = 512;
const MIN_CLEAN_FRACTION = 0.8;
const DEFINITIONS = createEegBands();
export interface ArtifactInterval { startMs: number; endMs: number }
export interface RobustEegSnapshot {
  timestampMs: number;
  lastGoodTimestampMs: number | null;
  ready: boolean;
  qualityAccepted: boolean;
  held: boolean;
  reason: string;
  cleanFraction: number;
  cleanSegments: number;
  reconstructedFraction?:number;
  windowSeconds: number;
  shares: BandShare[];
  powers: Record<EegBandKey, number>;
  artifactIntervals: ArtifactInterval[];
  spectrum: PowerSpectrumSnapshot | null;
  /** Untrusted, explicitly labelled preview. Never enters powers/control metrics. */
  displaySpectrum?: PowerSpectrumSnapshot | null;
  displayShares?: BandShare[];
  displaySegmentSeconds?:number;
  execution?:'worker'|'main-thread-fallback';
}

const EMPTY_POWER = { delta: 0, theta: 0, alpha: 0, beta: 0 };
export function emptyRobustEegSnapshot(): RobustEegSnapshot {
  return { timestampMs: 0, lastGoodTimestampMs: null, ready: false, qualityAccepted: false,
    held: false, reason: '等待约8.5秒有效数据（含抗混叠预热）', cleanFraction: 0, cleanSegments: 0,
    windowSeconds: SPECTRAL_WINDOW_SECONDS, powers: { ...EMPTY_POWER },
    shares: DEFINITIONS.map(band => ({ label: band.label, value: 0, percent: 0 })), artifactIntervals: [], spectrum:null };
}

/** Fixed causal 8 s PSD, 1 s updates. No stage-dependent multipliers, CAR,
 * beta enhancement or display-waveform energy enters the relative powers. */
export class RobustEegAnalyzer {
  private key = '';
  private snapshot = emptyRobustEegSnapshot();
  update(key: string, values: TimedValue[], sampleRate: number,
    ranges: Record<EegBandKey, BandRange>, context?: SleepDeltaArtifactContext): RobustEegSnapshot {
    const timestamp = values[values.length-1]?.timestamp ?? 0;
    const streamKey = `${key}|${sampleRate}|${JSON.stringify(ranges)}`;
    if (streamKey !== this.key || timestamp < this.snapshot.timestampMs) {
      this.key = streamKey; this.snapshot = emptyRobustEegSnapshot();
    }
    if (this.snapshot.timestampMs && timestamp-this.snapshot.timestampMs < 1000) return this.snapshot;
    const result = analyzeEegWindow(values, sampleRate, ranges, context);
    // Keep past masks for the longest display window. Otherwise an artifact
    // would reappear when it left the 8-second analysis window.
    result.artifactIntervals = mergeIntervals([...this.snapshot.artifactIntervals,...result.artifactIntervals]
      .filter(interval=>interval.endMs>=timestamp-65000),1000/sampleRate+.0001);
    if (!result.qualityAccepted && this.snapshot.lastGoodTimestampMs !== null) {
      result.powers = this.snapshot.powers; result.shares = this.snapshot.shares;
      result.lastGoodTimestampMs = this.snapshot.lastGoodTimestampMs; result.held = true;
      result.spectrum=this.snapshot.spectrum;
    }
    this.snapshot = result; return result;
  }
}

export function analyzeEegWindow(values: TimedValue[], sampleRate: number,
  ranges: Record<EegBandKey, BandRange>, context?: SleepDeltaArtifactContext): RobustEegSnapshot {
  const result = emptyRobustEegSnapshot(); result.timestampMs = values[values.length-1]?.timestamp ?? 0;
  if (!(sampleRate >= 100 && sampleRate <= 1000)) { result.reason='采样率无效';return result; }
  // Extra history is exclusively anti-alias FIR support, never the UI window.
  const native = timeWindow(values,result.timestampMs-9500);
  if (native.length < sampleRate*8.5) return result;
  const clockFraction=native.filter(point=>point.observed===false&&point.valid!==false).length/native.length;
  if(clockFraction>.05){
    result.ready=true;result.cleanFraction=0;
    result.reason=`兼容时基重建${(clockFraction*100).toFixed(1)}%，实测覆盖不足，控制指标暂停`;
    // No full strict FIR/artifact pass: it cannot make unobserved data genuine.
    return attachDisplayPreview(result,native,sampleRate,ranges,context);
  }
  // Only very short, bracketed transport gaps may be reconstructed in this
  // analysis copy (<=20ms, <=5% of the window). Raw validity is unchanged.
  const repaired=repairShortSpectralGaps(native,sampleRate);
  const marked = markArtifacts(repaired.values, sampleRate, context);
  result.reconstructedFraction=repaired.fraction;
  result.artifactIntervals = marked.intervals;
  const sampled = antiAliasedResample(marked.values, sampleRate).slice(-PSD_RATE*SPECTRAL_WINDOW_SECONDS);
  if (sampled.length < PSD_RATE*SPECTRAL_WINDOW_SECONDS) return result;
  result.ready = true;
  const actualClean=maskArtifactIntervals(native,marked.intervals).filter(point=>point.valid!==false&&Number.isFinite(point.value)).length/native.length;
  result.cleanFraction = Math.min(actualClean,sampled.filter(point => point.valid !== false && Number.isFinite(point.value)).length/sampled.length);
  if (result.cleanFraction < MIN_CLEAN_FRACTION) { result.reason='伪迹/丢包过多，控制指标暂停';return attachDisplayPreview(result,native,sampleRate,ranges,context); }
  const spectra: number[][] = [];
  for (let start=0;start+SEGMENT_SAMPLES<=sampled.length;start+=SEGMENT_SAMPLES/2) {
    const segment=sampled.slice(start,start+SEGMENT_SAMPLES);
    // Never bridge a transport gap with fabricated spectral samples.
    if (segment.some(point => point.valid === false || !Number.isFinite(point.value))) continue;
    spectra.push(welchSegment(segment.map(point => point.value)));
  }
  result.cleanSegments=spectra.length;
  if (!spectra.length) { result.reason='没有完整4秒无伪迹分析段，控制指标暂停';return attachDisplayPreview(result,native,sampleRate,ranges,context); }
  const psd=spectra[0].map((_,bin)=>spectra.reduce((sum,segment)=>sum+segment[bin],0)/spectra.length);
  const powers={...EMPTY_POWER};
  for (const band of DEFINITIONS) {
    const range=ranges[band.key];
    if (!(range.high>range.low && range.low>=0.5 && range.high<=45)) { result.reason='频带范围无效';return result; }
    powers[band.key]=integratePsd(psd,range.low,range.high);
  }
  const total=Object.values(powers).reduce((sum,power)=>sum+power,0);
  const highFrequency=integratePsd(psd,30,45);
  if (!(total>1e-10)) { result.reason='信号平直或功率不足';return result; }
  if (highFrequency/(total+highFrequency)>0.55) { result.reason='高频肌电/噪声过强，控制指标暂停';return attachDisplayPreview(result,native,sampleRate,ranges,context); }
  const bins=psd.map((power,bin)=>({frequencyHz:bin*PSD_RATE/FFT_SIZE,power})).filter(point=>point.frequencyHz>=0.5&&point.frequencyHz<=45);
  const maximum=Math.max(...bins.map(point=>point.power),1e-12);
  const points=bins.map(point=>({frequencyHz:point.frequencyHz,powerDb:Math.max(-60,10*Math.log10(Math.max(point.power,1e-12)/maximum))}));
  result.spectrum={points,windowStartMs:sampled[0].timestamp,windowEndMs:sampled[sampled.length-1].timestamp,
    peakFrequencyHz:bins.reduce((best,point)=>point.power>best.power?point:best,bins[0]).frequencyHz,
    resolutionHz:PSD_RATE/FFT_SIZE,windowSeconds:8,fftSize:FFT_SIZE,minimumDb:-60,maximumFrequencyHz:45};
  result.powers=powers;
  result.shares=DEFINITIONS.map(band=>({label:band.label,value:powers[band.key],percent:powers[band.key]/total*100}));
  result.qualityAccepted=true;result.lastGoodTimestampMs=result.timestampMs;
  result.reason=`8秒功率 · ${spectra.length}个可用分段 · 1秒更新${repaired.fraction>0?` · 短缺样重建${(repaired.fraction*100).toFixed(1)}%`:''}`;
  return result;
}

export function repairShortSpectralGaps(source:TimedValue[],rate:number,maximumMs=20,maximumFraction=.05):{values:TimedValue[];fraction:number} {
  const invalid=(point:TimedValue)=>point.valid===false||point.observed===false||!Number.isFinite(point.value);
  const missing=source.filter(invalid).length;
  if(!missing||missing/source.length>maximumFraction)return {values:source,fraction:0};
  const values=source.slice();let repaired=0;
  for(let start=0;start<values.length;start++) {
    if(!invalid(source[start]))continue;let end=start;while(end<source.length&&invalid(source[end]))end++;
    const left=source[start-1],right=source[end];
    if(left&&right&&(end-start)*1000/rate<=maximumMs&&right.timestamp-left.timestamp<=maximumMs+1000/rate
      &&Math.abs(left.value)<0x7f0000&&Math.abs(right.value)<0x7f0000) {
      for(let index=start;index<end;index++){const fraction=(source[index].timestamp-left.timestamp)/(right.timestamp-left.timestamp);
        values[index]={...source[index],value:left.value+(right.value-left.value)*fraction,valid:true};repaired++;}
    }
    start=end-1;
  }
  return {values,fraction:repaired/source.length};
}

function attachDisplayPreview(result:RobustEegSnapshot,native:TimedValue[],rate:number,
  ranges:Record<EegBandKey,BandRange>,context?:SleepDeltaArtifactContext):RobustEegSnapshot {
  // The UI may show an explicitly untrusted estimate with <=100ms bracketed
  // gaps and <=20% reconstruction. Control still uses the strict 20ms/5% gate.
  const clockReconstruction=native.filter(point=>point.observed===false&&point.valid!==false).length/native.length;
  const inspectionSource=native.map(point=>point.observed===false&&point.valid!==false?{...point,observed:undefined}:point);
  const repaired=repairShortSpectralGaps(inspectionSource,rate,100,.2);
  const marked=markArtifacts(repaired.values,rate,context);
  let sampled=antiAliasedResample(marked.values,rate).slice(-PSD_RATE*SPECTRAL_WINDOW_SECONDS);
  if(sampled.length<PSD_RATE*SPECTRAL_WINDOW_SECONDS)return result;
  const available=sampled.filter(point=>point.valid!==false&&Number.isFinite(point.value)).length/sampled.length;
  let includesArtifacts=false;
  if(available<.5){
    // Inspection must not stay blank just because artifact rejection vetoed
    // the control result. Show received non-saturated data as untrusted PSD.
    // This does not recover EEG or remove the artifacts from the displayed PSD.
    sampled=antiAliasedResample(repaired.values.map(point=>Math.abs(point.value)>=0x7f0000?
      {...point,value:NaN,valid:false}:point),rate).slice(-PSD_RATE*SPECTRAL_WINDOW_SECONDS);
    if(sampled.filter(point=>point.valid!==false&&Number.isFinite(point.value)).length/sampled.length<.5)return result;
    includesArtifacts=true;
  }
  let spectra:number[][]=[],segmentSeconds=4;
  for(const length of [400,200]){
    for(let start=0;start+length<=sampled.length;start+=length/2){
      const segment=sampled.slice(start,start+length);
      if(segment.every(point=>point.valid!==false&&Number.isFinite(point.value)))spectra.push(welchSegment(segment.map(point=>point.value)));
    }
    if(spectra.length){segmentSeconds=length/PSD_RATE;break;}
  }
  if(!spectra.length)return result;
  const psd=spectra[0].map((_,bin)=>spectra.reduce((sum,item)=>sum+item[bin],0)/spectra.length);
  const shares=DEFINITIONS.map(band=>({label:band.label,value:integratePsd(psd,ranges[band.key].low,ranges[band.key].high),percent:0}));
  const total=shares.reduce((sum,item)=>sum+item.value,0);
  if(!(total>1e-10))return result;
  for(const share of shares)share.percent=share.value/total*100;
  const bins=psd.map((power,bin)=>({frequencyHz:bin*PSD_RATE/FFT_SIZE,power})).filter(point=>point.frequencyHz>=.5&&point.frequencyHz<=45);
  const peak=bins.reduce((best,point)=>point.power>best.power?point:best,bins[0]);
  result.displayShares=shares;
  result.displaySpectrum={points:bins.map(point=>({frequencyHz:point.frequencyHz,powerDb:Math.max(-60,10*Math.log10(Math.max(point.power,1e-12)/Math.max(peak.power,1e-12)))})),
    windowStartMs:sampled[0].timestamp,windowEndMs:sampled[sampled.length-1].timestamp,peakFrequencyHz:peak.frequencyHz,
    resolutionHz:PSD_RATE/FFT_SIZE,windowSeconds:8,fftSize:FFT_SIZE,minimumDb:-60,maximumFrequencyHz:45};
  result.displaySegmentSeconds=segmentSeconds;
  result.reason+=` · 仅供观察${includesArtifacts?'（含未剔除伪迹）':''}：${spectra.length}个${segmentSeconds}秒分段，短缺样估计${(repaired.fraction*100).toFixed(1)}%${clockReconstruction>0?`，兼容时基重建${(clockReconstruction*100).toFixed(1)}%`:''}，不参与控制`;
  return result;
}

function welchSegment(source:number[]):number[] {
  const mean=source.reduce((sum,value)=>sum+value,0)/source.length;
  const center=(source.length-1)/2;
  let numerator=0,denominator=0;
  for(let i=0;i<source.length;i++){numerator+=(i-center)*(source[i]-mean);denominator+=(i-center)**2;}
  const slope=numerator/Math.max(1,denominator);
  const real=new Float64Array(FFT_SIZE),imaginary=new Float64Array(FFT_SIZE);let energy=0;
  for(let i=0;i<source.length;i++) {
    const hann=0.5-0.5*Math.cos(2*Math.PI*i/source.length);energy+=hann*hann;
    real[i]=(source[i]-mean-slope*(i-center))*hann;
  }
  fftInPlace(real,imaginary);
  return Array.from({length:FFT_SIZE/2+1},(_,bin)=>(real[bin]**2+imaginary[bin]**2)/(PSD_RATE*energy)*(bin===0||bin===FFT_SIZE/2?1:2));
}

function integratePsd(psd:number[],low:number,high:number):number {
  const width=PSD_RATE/FFT_SIZE;let power=0;
  for(let bin=1;bin<psd.length;bin++) {
    const overlap=Math.max(0,Math.min(high,(bin+0.5)*width)-Math.max(low,(bin-0.5)*width));
    power+=psd[bin]*overlap;
  }
  return power;
}

/** Hamming-windowed sinc low-pass before 100 Hz conversion. Centered FIR is
 * computed only from already received data; newest ~240 ms are not analyzed. */
export function antiAliasedResample(values:TimedValue[],inputRate:number):TimedValue[] {
  const radius=Math.ceil(inputRate/PSD_RATE*24),cutoff=40/inputRate;
  let kernel=KERNEL_CACHE.get(inputRate);
  if(!kernel){kernel=Array.from({length:radius*2+1},(_,index)=>{
    const offset=index-radius;
    const sinc=offset===0?2*cutoff:Math.sin(2*Math.PI*cutoff*offset)/(Math.PI*offset);
    return sinc*(0.54+0.46*Math.cos(Math.PI*offset/radius));
  });KERNEL_CACHE.set(inputRate,kernel);}
  const sum=kernel.reduce((a,b)=>a+b,0);const step=inputRate/PSD_RATE;
  const output:TimedValue[]=[];
  const center=quantile(values.filter(point=>point.valid!==false&&Number.isFinite(point.value)).map(point=>point.value),0.5);
  for(let position=radius;position+radius+1<values.length;position+=step) {
    const middle=Math.floor(position),fraction=position-middle;let value=0,valid=true;
    for(let k=-radius;k<=radius;k++) {
      const left=values[middle+k],right=values[middle+k+1];
      const usable=left.valid!==false&&right.valid!==false&&left.observed!==false&&right.observed!==false&&Number.isFinite(left.value)&&Number.isFinite(right.value);
      if(!usable) valid=false;
      value+=kernel[k+radius]*(usable?left.value*(1-fraction)+right.value*fraction-center:0);
    }
    output.push({timestamp:values[middle].timestamp*(1-fraction)+values[middle+1].timestamp*fraction,value:value/sum,valid});
  }
  return output;
}
const KERNEL_CACHE=new Map<number,number[]>();

function markArtifacts(values:TimedValue[],rate:number,context?:SleepDeltaArtifactContext):{values:TimedValue[];intervals:ArtifactInterval[]} {
  const finite=values.filter(point=>point.valid!==false&&Number.isFinite(point.value)).map(point=>point.value);
  const center=quantile(finite,0.5),amplitudes=finite.map(value=>Math.abs(value-center));
  const amplitudeLimit=Math.max(1,quantile(amplitudes,0.75)+8*iqr(amplitudes),quantile(amplitudes,0.5)*8);
  // A fixed 10ms derivative is rate-invariant. Adjacent 1kHz quantized/held
  // samples otherwise make the median/IQR nearly zero and veto every packet
  // endpoint, dilating a few real changes into an entirely rejected window.
  const slopeLag=Math.max(1,Math.round(rate*.01));
  const differences=values.slice(slopeLag).flatMap((point,index)=>point.valid!==false&&values[index].valid!==false
    &&Number.isFinite(point.value)&&Number.isFinite(values[index].value)?[Math.abs(point.value-values[index].value)]:[]);
  const slopeLimit=Math.max(1,quantile(differences,0.75)+8*iqr(differences),quantile(differences,0.5)*12);
  const intervals:ArtifactInterval[]=[];
  for(let i=0;i<values.length;i++) {
    const point=values[i];
    const missing=point.valid===false||point.observed===false||!Number.isFinite(point.value)||Math.abs(point.value)>=0x7f0000;
    const transient=!missing&&(Math.abs(point.value-center)>amplitudeLimit||(i>=slopeLag&&values[i-slopeLag].valid!==false&&Math.abs(point.value-values[i-slopeLag].value)>slopeLimit));
    const gap=i>0&&(point.timestamp<=values[i-1].timestamp||point.timestamp-values[i-1].timestamp>3000/rate);
    if(missing||transient||gap) intervals.push({startMs:point.timestamp-(transient?150:0),endMs:point.timestamp+(transient?600:0)});
  }
  const axes=context?.accelerometer;
  if(axes) for(const axis of [axes.x,axes.y,axes.z]) {
    const recent=axis.filter(point=>point.timestamp>=values[0].timestamp&&point.timestamp<=values[values.length-1].timestamp);
    const steps=recent.slice(1).flatMap((point,index)=>point.valid!==false&&recent[index].valid!==false
      &&Number.isFinite(point.value)&&Number.isFinite(recent[index].value)?[Math.abs(point.value-recent[index].value)]:[]);
    // ACC is held across the EEG samples in one BLE packet. Those duplicate
    // zeros must not force the noise IQR to zero and veto every quantization step.
    const changes=steps.filter(value=>value>0);
    const noise=changes.length>=16?changes:steps;
    const limit=Math.max(1,quantile(noise,0.75)+8*iqr(noise),quantile(noise,0.5)*12);
    for(let i=1;i<recent.length;i++) if(recent[i].valid!==false&&recent[i-1].valid!==false&&Math.abs(recent[i].value-recent[i-1].value)>limit)
      intervals.push({startMs:recent[i].timestamp-200,endMs:recent[i].timestamp+700});
  }
  const merged=mergeIntervals(intervals,1000/rate+.0001);
  return {values:maskArtifactIntervals(values,merged),intervals:merged};
}

function mergeIntervals(intervals:ArtifactInterval[],joinMs=0):ArtifactInterval[] {
  intervals.sort((a,b)=>a.startMs-b.startMs);
  const merged:ArtifactInterval[]=[];
  for(const item of intervals){const previous=merged[merged.length-1];if(previous&&item.startMs<=previous.endMs+joinMs)previous.endMs=Math.max(previous.endMs,item.endMs);else merged.push({...item});}
  return merged;
}

export function maskArtifactIntervals(values:TimedValue[],intervals:ArtifactInterval[]):TimedValue[] {
  let index=0;
  return values.map(point=>{
    while(index<intervals.length&&intervals[index].endMs<point.timestamp)index++;
    return index<intervals.length&&intervals[index].startMs<=point.timestamp
      ? {...point,value:Number.NaN,valid:false}:point;
  });
}

export function spectralSleepMetrics(snapshot:RobustEegSnapshot):SleepMetrics {
  // Keep legacy spectral control fields compatible, but never synthesize
  // vertex/K-complex/N2 events from a PSD or artifact amplitude.
  return calculateSleepMetrics({rawValues:[],bands:DEFINITIONS.map(band=>({label:band.label,
    values:[{timestamp:snapshot.timestampMs,value:Math.sqrt(snapshot.powers[band.key])}]})),spindleValues:[]});
}

export function quantile(values:number[],fraction:number):number {
  if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);
  const position=(sorted.length-1)*fraction,low=Math.floor(position),high=Math.ceil(position);
  return sorted[low]+(sorted[high]-sorted[low])*(position-low);
}
function iqr(values:number[]):number{return quantile(values,0.75)-quantile(values,0.25);}
