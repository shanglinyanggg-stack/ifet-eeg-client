import {describe,expect,test} from 'vitest';
import {interpolateDisplayGaps,rasterizeWaveform,timeWindow,lowerTimestamp} from './display-window';
describe('native-rate presentation',()=>{
  test('binary-window selection matches filtering at all native rates',()=>{
    for(const rate of [125,250,500,1000]){
      const values=Array.from({length:rate*65},(_,index)=>({timestamp:index*1000/rate,value:index}));
      expect(timeWindow(values,45000,55000)).toEqual(values.filter(point=>point.timestamp>=45000&&point.timestamp<=55000));
      expect(lowerTimestamp(values,45000,true)).toBeGreaterThan(lowerTimestamp(values,45000));
    }
  });
  test('short interpolation keeps invalid flags and leaves original acquisition untouched',()=>{
    const source=[{timestamp:0,value:0,valid:true},{timestamp:8,value:NaN,valid:false},{timestamp:16,value:16,valid:true}];
    const output=interpolateDisplayGaps(source);
    expect(output[1]).toEqual({timestamp:8,value:8,valid:false,interpolated:true});
    expect(source[1].value).toBeNaN();expect(source[1].valid).toBe(false);
    expect(source[0]).toBe(output[0]);
  });
  test('does not bridge long gaps or one-sided gaps',()=>{
    const source=[{timestamp:0,value:NaN,valid:false},{timestamp:8,value:1},{timestamp:16,value:NaN,valid:false},{timestamp:200,value:2}];
    expect(interpolateDisplayGaps(source)).toBe(source);
  });
  test('compatibility reconstruction is hidden with the switch off and only dashed with it on',()=>{
    const values=[{timestamp:0,value:0},{timestamp:8,value:999,observed:false},{timestamp:16,value:16}];
    expect(rasterizeWaveform(values,0,16,100).points[1].observed).toBe(false);
    const output=interpolateDisplayGaps(values);
    expect(output[1].value).toBe(8);expect(output[1].interpolated).toBe(true);expect(values[1].value).toBe(999);
  });
  test('all native spikes contribute to pixel min/max, including the final pixel',()=>{
    const source=Array.from({length:60000},(_,index)=>({timestamp:index,value:index===37483?9999:index===59990?-7777:0}));
    const raster=rasterizeWaveform(source,0,59999,1000);
    expect(raster.points.some(point=>point.value===9999)).toBe(true);
    expect(raster.points.some(point=>point.value===-7777)).toBe(true);
    expect(raster.maxAbs).toBe(9999);expect(raster.points.length).toBeLessThanOrEqual(4000);
    expect(source.length).toBe(60000);
  });
  test('pixel envelope retains invalid breaks; only enabled short time gaps become dashed',()=>{
    const source=Array.from({length:100},(_,index)=>({timestamp:index+(index>40?50:0),value:Math.sin(index)}));
    expect(rasterizeWaveform(source,0,149,10).points.some(point=>point.valid===false&&!Number.isFinite(point.value))).toBe(true);
    expect(rasterizeWaveform(source,0,149,10,true).points.some(point=>point.interpolated)).toBe(true);
    const long=source.map(point=>({...point,timestamp:point.timestamp+(point.timestamp>90?1000:0)}));
    expect(rasterizeWaveform(long,0,1149,10,true).points.some(point=>point.valid===false&&!point.interpolated)).toBe(true);
  });
});
