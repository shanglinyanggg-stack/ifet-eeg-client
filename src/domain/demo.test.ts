import {describe,expect,test,vi} from 'vitest';
import {createDemoSamples} from './demo';
describe('native-rate demo timebase',()=>{
  test('uses the selected sample interval at all four rates',()=>{
    vi.spyOn(Date,'now').mockReturnValue(1780000000000);
    for(const rate of [125,250,500,1000]){
      const values=createDemoSamples(20,rate);
      expect(values.every(point=>point.sampleRateHz===rate)).toBe(true);
      for(let i=1;i<values.length;i++)expect(Date.parse(values[i].timestamp)-Date.parse(values[i-1].timestamp)).toBe(1000/rate);
    }
    vi.restoreAllMocks();
  });
});
