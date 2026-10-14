import {describe,expect,test} from 'vitest';
import {defaultSignalDisplay,resolveMicrovoltsPerCount,signalDisplayUnit,normalizeSignalDisplay,timeAxisTicks} from './signal-display';
describe('display-only EEG units and time axes',()=>{
  test('never invents a microvolt coefficient',()=>{
    expect(resolveMicrovoltsPerCount(defaultSignalDisplay)).toBeNull();
    expect(resolveMicrovoltsPerCount({...defaultSignalDisplay,microvoltsPerCount:.5})).toBeNull();
    expect(signalDisplayUnit('EEG1',{...defaultSignalDisplay,eegUnit:'uv'})).toEqual({label:'ADC',factor:1,isEeg:true});
  });
  test('uses an explicitly confirmed per-count coefficient for EEG and derived bands only',()=>{
    const settings={...defaultSignalDisplay,eegUnit:'uv' as const,microvoltsPerCount:.025,calibrationConfirmed:true};
    for(const label of ['EEG1','EEG2','Delta','Theta','Alpha','Beta','Gamma'])expect(signalDisplayUnit(label,settings).factor).toBe(.025);
    for(const label of ['IR1','Red2','Green1','accX'])expect(signalDisplayUnit(label,settings).factor).toBe(1);
  });
  test('bipolar 24-bit formula is correct only after hardware parameters are confirmed',()=>{
    const settings={...defaultSignalDisplay,calibrationMode:'bipolar24' as const,referenceVolts:4.5,totalGain:24,calibrationConfirmed:true};
    expect(resolveMicrovoltsPerCount(settings)).toBeCloseTo(.022351741790771484,12);
    expect(resolveMicrovoltsPerCount({...settings,totalGain:0})).toBeNull();
    expect(resolveMicrovoltsPerCount({...settings,referenceVolts:null})).toBeNull();
  });
  test('sanitizes invalid persisted parameters',()=>{
    const output=normalizeSignalDisplay({microvoltsPerCount:Infinity,totalGain:-1,referenceVolts:NaN,calibrationConfirmed:true});
    expect(output.microvoltsPerCount).toBeNull();expect(output.totalGain).toBeNull();
    expect(resolveMicrovoltsPerCount(output)).toBeNull();
  });
  test('all relative ticks use the latest plotted sample as zero',()=>{
    const ticks=timeAxisTicks(1000,11000,800,'relative');
    expect(ticks[0].label).toBe('-10s');expect(ticks[ticks.length-1].label).toBe('0s');
    expect(ticks[0].timestamp).toBe(1000);expect(ticks[ticks.length-1].timestamp).toBe(11000);
  });
});
