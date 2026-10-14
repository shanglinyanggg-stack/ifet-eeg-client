import {test,expect} from 'vitest';
import {FilterChain,StreamingFilterCache,type TimedValue} from './dsp';
import {analyzeEegWindow,repairShortSpectralGaps} from './robust-eeg';
import {defaultSettings} from './settings';
for(const rate of [125,250,500,1000])test(`DC restart and short missing packets remain stable at ${rate}Hz`,()=>{
  const source:TimedValue[]=Array.from({length:rate*12},(_,index)=>({timestamp:index*1000/rate,value:-125000+100*Math.sin(2*Math.PI*10*index/rate),
    valid:!(index%(rate*2)>=Math.round(rate*.9)&&index%(rate*2)<Math.round(rate*.9)+Math.max(1,Math.round(rate*.008)))}));
  const before=source.map(point=>({...point}));const cache=new StreamingFilterCache();
  const filtered=cache.update('eeg',source,()=>FilterChain.butterworthBandpass({low:.5,high:30,sampleRate:rate,order:2}));
  expect(Math.max(...filtered.filter(point=>point.valid!==false).map(point=>Math.abs(point.value)))).toBeLessThan(250);
  expect(filtered.filter(point=>Number.isNaN(point.value)).length).toBe(source.filter(point=>point.valid===false).length);
  expect(source).toEqual(before);
  const power=analyzeEegWindow(source,rate,defaultSettings.eeg.bandRanges);
  expect(power.qualityAccepted,power.reason).toBe(true);expect(power.reconstructedFraction).toBeGreaterThan(0);
  expect(power.shares.find(item=>item.label==='Alpha')!.percent).toBeGreaterThan(95);
});
test('long and excessive gaps are never silently reconstructed',()=>{
  const source=Array.from({length:1000},(_,index)=>({timestamp:index*2,value:index,valid:index<300||index>400}));
  expect(repairShortSpectralGaps(source,500).fraction).toBe(0);
  const cache=new StreamingFilterCache();const output=cache.update('long',source.map(point=>({...point,value:-125000})),
    ()=>FilterChain.butterworthBandpass({low:.5,high:30,sampleRate:500,order:2}));
  expect(Math.abs(output[401].value)).toBeLessThan(.001);
});

test('packet-held ACC quantization noise does not mask the entire EEG window',()=>{
  const rate=500;const eeg=Array.from({length:rate*10},(_,index)=>({timestamp:index*2,value:100*Math.sin(2*Math.PI*10*index/rate),valid:true}));
  const acc=eeg.map((point,index)=>({...point,value:-1000+Math.floor(index/4)%3*4}));
  const output=analyzeEegWindow(eeg,rate,defaultSettings.eeg.bandRanges,{accelerometer:{x:acc,y:[],z:[]}});
  expect(output.qualityAccepted,output.reason).toBe(true);expect(output.cleanFraction).toBeGreaterThan(.95);
});
