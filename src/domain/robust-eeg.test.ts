import {describe,expect,test} from 'vitest';
import {analyzeEegWindow,antiAliasedResample,RobustEegAnalyzer} from './robust-eeg';
import {defaultSettings} from './settings';
import type {TimedValue} from './dsp';

const ranges=defaultSettings.eeg.bandRanges;
function signal(rate:number,frequencies:Array<[number,number]>,seconds=10,start=0):TimedValue[]{
  return Array.from({length:Math.round(seconds*rate)},(_,index)=>({timestamp:start+index*1000/rate,
    value:frequencies.reduce((sum,[frequency,amplitude])=>sum+amplitude*Math.sin(2*Math.PI*frequency*index/rate),0),valid:true}));
}
describe('quality-gated Welch relative powers',()=>{
  for(const rate of [125,250,500,1000]) test(`preserves band identity at native ${rate} Hz`,()=>{
    for(const [frequency,expected] of [[2,'Delta'],[6,'Theta'],[10,'Alpha'],[20,'Beta']] as const){
      const output=analyzeEegWindow(signal(rate,[[frequency,100]]),rate,ranges);
      expect(output.qualityAccepted,output.reason).toBe(true);
      expect(output.shares.reduce((a,b)=>a.percent>b.percent?a:b).label).toBe(expected);
      expect(output.shares.find(band=>band.label===expected)!.percent).toBeGreaterThan(97);
      expect(output.shares.reduce((sum,band)=>sum+band.percent,0)).toBeCloseTo(100,6);
    }
  });
  test('uses squared power instead of waveform mean amplitude',()=>{
    const output=analyzeEegWindow(signal(250,[[10,200],[20,100]]),250,ranges);
    expect(Math.abs(output.powers.alpha/output.powers.beta-4)).toBeLessThan(0.15);
    expect(output.shares.find(item=>item.label==='Alpha')!.percent).toBeCloseTo(80,0);
  });
  test('linear drift and DC do not become Delta',()=>{
    const values=signal(500,[[10,100]]).map((point,index)=>({...point,value:point.value+30000+index*0.4}));
    const output=analyzeEegWindow(values,500,ranges);
    expect(output.qualityAccepted,output.reason).toBe(true);
    expect(output.shares.find(item=>item.label==='Delta')!.percent).toBeLessThan(1);
  });
  test('anti-aliasing rejects a 90 Hz tone before 100 Hz conversion',()=>{
    const values=signal(1000,[[90,100]]);
    const resampled=antiAliasedResample(values,1000);
    const rms=Math.sqrt(resampled.reduce((sum,point)=>sum+point.value**2,0)/resampled.length);
    expect(rms).toBeLessThan(0.1);
  });
  test('holds the last valid result through major blinks, motion, and packet gaps',()=>{
    const analyzer=new RobustEegAnalyzer();
    const first=analyzer.update('eeg1',signal(125,[[10,100]]),125,ranges);
    expect(first.qualityAccepted).toBe(true);
    const next=signal(125,[[10,100]],10,1000).map(point=>point.timestamp>3500&&point.timestamp<6500
      ? {...point,valid:false}:point);
    const rejected=analyzer.update('eeg1',next,125,ranges);
    expect(rejected.qualityAccepted).toBe(false);
    expect(rejected.held).toBe(true);
    expect(rejected.shares).toEqual(first.shares);
    const blink=signal(125,[[10,100]],10,2000).map(point=>point.timestamp>6000&&point.timestamp<7500
      ? {...point,value:point.value+8000}:point);
    const blinkResult=analyzer.update('eeg1',blink,125,ranges);
    expect(blinkResult.artifactIntervals.length).toBeGreaterThan(0);
    expect(blinkResult.qualityAccepted).toBe(false);
    expect(blinkResult.shares).toEqual(first.shares);
    const raw=signal(125,[[10,100]],10,3000);
    const acc=raw.map(point=>({...point,value:point.timestamp>9000?500:0}));
    const motion=analyzer.update('eeg1',raw,125,ranges,{accelerometer:{x:acc,y:[],z:[]}});
    expect(motion.artifactIntervals.length).toBeGreaterThan(0);
  });
  test('updates no faster than once per second and resets on rate change',()=>{
    const analyzer=new RobustEegAnalyzer();
    const values=signal(125,[[10,100]]);
    const first=analyzer.update('eeg1',values,125,ranges);
    expect(analyzer.update('eeg1',[...values,{timestamp:10000,value:0}],125,ranges)).toBe(first);
    const reset=analyzer.update('eeg1',signal(1000,[[10,100]],1),1000,ranges);
    expect(reset.held).toBe(false);
    expect(reset.lastGoodTimestampMs).toBeNull();
  });
  test('rejects flat and saturated signals rather than outputting a plausible score',()=>{
    for(const value of [0,0x7fffff]){
      const output=analyzeEegWindow(signal(125,[]).map(point=>({...point,value})),125,ranges);
      expect(output.qualityAccepted).toBe(false);
    }
  });
  test('frequent 8% short loss shows an untrusted preview without entering control powers',()=>{
    const values=signal(1000,[[10,100]]).map((point,index)=>index%100<8?{...point,valid:false}:point);
    const original=values.map(point=>({...point}));
    const output=analyzeEegWindow(values,1000,ranges);
    expect(output.qualityAccepted).toBe(false);expect(output.powers.alpha).toBe(0);
    expect(output.displaySpectrum?.points.length).toBeGreaterThan(100);
    expect(output.displayShares!.find(band=>band.label==='Alpha')!.percent).toBeGreaterThan(95);
    expect(output.reason).toContain('不参与控制');expect(values).toEqual(original);
  });
  test('quantized packet-like high-rate steps do not mask the whole signal',()=>{
    const values=signal(1000,[[10,20],[20,10]]).map(point=>({...point,value:Math.round(point.value)}));
    const output=analyzeEegWindow(values,1000,ranges);
    expect(output.cleanFraction).toBeGreaterThan(.9);expect(output.qualityAccepted).toBe(true);
  });
  test('legacy clock reconstruction never becomes trusted EEG control evidence',()=>{
    const values=signal(1000,[[10,100]]).map((point,index)=>({...point,observed:index%32>=24}));
    const output=analyzeEegWindow(values,1000,ranges);
    expect(output.qualityAccepted).toBe(false);expect(output.powers.alpha).toBe(0);
    expect(output.displaySpectrum?.points.length).toBeGreaterThan(100);expect(output.reason).toContain('兼容时基重建');
  });
});
