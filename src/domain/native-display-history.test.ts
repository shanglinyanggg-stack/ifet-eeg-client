import {expect,test} from 'vitest';
import {NativeDisplayHistory,displaySnapshotSeconds} from './native-display-history';
test('65s history retains every native sample once and expands the viewport immediately',()=>{
  for(const rate of [125,250,500,1000]){
    const history=new NativeDisplayHistory(['eeg1','eeg2']);
    const values=Array.from({length:rate*70},(_,index)=>({timestamp:index*1000/rate,value:index}));
    for(let index=0;index<values.length;index+=rate)history.append({eeg1:values.slice(index,index+rate),eeg2:values.slice(index,index+rate)},rate);
    expect(history.maxRetainedPoints).toBe(rate*65);
    const brief=history.snapshot(10.5),long=history.snapshot(60);
    expect(brief.eeg1.length).toBe(Math.floor(rate*10.5));expect(long.eeg1.length).toBe(rate*60);
    expect(long.eeg1[0].timestamp).toBe(10000);expect(long.eeg1.at(-1)?.value).toBe(values.at(-1)?.value);
    history.reset();expect(history.snapshot(60).eeg1).toHaveLength(0);
  }
});
test('current snapshot supports 8s PSD warmup, display delay and 60s navigation without reducing rate',()=>{
  expect(displaySnapshotSeconds('auto',0)).toBe(10.5);
  expect(displaySnapshotSeconds(3,0)).toBe(10.5);
  expect(displaySnapshotSeconds(10,5000)).toBe(15.5);
  expect(displaySnapshotSeconds(60,5000)).toBe(65);
});
