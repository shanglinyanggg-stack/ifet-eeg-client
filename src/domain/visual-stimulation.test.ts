import { describe,expect,test } from 'vitest';
import { chooseVisualClock } from './visual-stimulation';
describe('screen render clock synchronization',()=>{
  test('uses the lowest latency probe instead of injecting delayed IPC into marker time',()=>{
    const clock=chooseVisualClock([{clientSend:100,clientReceive:120,hostTimeMs:210},{clientSend:200,clientReceive:202,hostTimeMs:301}]);
    expect(clock.offsetMs).toBe(100);expect(clock.uncertaintyMs).toBe(1);
    expect(350+clock.offsetMs).toBe(450);
  });
  test('rejects invalid and excessively uncertain clock mappings',()=>{
    expect(()=>chooseVisualClock([])).toThrow();
    expect(()=>chooseVisualClock([{clientSend:0,clientReceive:30,hostTimeMs:100}])).toThrow();
    expect(()=>chooseVisualClock([{clientSend:3,clientReceive:1,hostTimeMs:2}])).toThrow();
  });
  test('retains a one millisecond uncertainty floor for a quantized zero round trip',()=>{
    expect(chooseVisualClock([{clientSend:10,clientReceive:10,hostTimeMs:20}]).uncertaintyMs).toBe(1);
  });
});
