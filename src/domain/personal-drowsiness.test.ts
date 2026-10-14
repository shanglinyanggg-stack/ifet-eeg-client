import {describe,expect,test} from 'vitest';
import {PersonalDrowsinessEstimator} from './personal-drowsiness';
import {calculateSleepMetrics,type SleepMetrics} from './sleep-metrics';
const empty=calculateSleepMetrics({rawValues:[],bands:[],spindleValues:[]});
function metrics(theta:number,alpha:number,beta:number):SleepMetrics{return {...empty,thetaRelative:theta,alphaRelative:alpha,betaRelative:beta};}
const awake=metrics(.45,.2,.3);
function calibrated(){const estimator=new PersonalDrowsinessEstimator();estimator.startCalibration(0);
  for(let second=1;second<=20;second++)estimator.update(awake,second*1000,true);return estimator;}
describe('personal alert-baseline drowsiness index',()=>{
  test('does not silently infer an alert baseline or display a probability',()=>{
    const estimator=new PersonalDrowsinessEstimator();
    let result=estimator.update(awake,0,true);
    for(let i=1;i<60;i++)result=estimator.update(awake,i*1000,true);
    expect(result.baselineReady).toBe(false);
    expect(result.status).toBe('uncalibrated');
    expect(result.featureScore).toBeNull();
  });
  test('counts 20 real seconds of good signal and pauses on artifacts',()=>{
    const estimator=new PersonalDrowsinessEstimator();estimator.startCalibration(1000);
    let result=estimator.update(awake,2000,true);
    for(let i=3;i<=11;i++)result=estimator.update(awake,i*1000,true);
    expect(result.baselineProgress).toBeCloseTo(.5);
    for(let i=12;i<=21;i++)result=estimator.update(awake,i*1000,false);
    expect(result.baselineProgress).toBeCloseTo(.5);
    for(let i=22;i<=31;i++)result=estimator.update(awake,i*1000,true);
    expect(result.baselineProgress).toBe(1);
    expect(result.baselineReady).toBe(true);
    expect(result.calibrationActive).toBe(false);
  });
  test('does not count UI rerenders as baseline time',()=>{
    const estimator=new PersonalDrowsinessEstimator();estimator.startCalibration(0);
    let result=estimator.update(awake,0,true);
    for(let i=0;i<1000;i++)result=estimator.update(awake,1000,true);
    expect(result.baselineProgress).toBeCloseTo(.05);
    expect(result.baselineReady).toBe(false);
  });
  test('naturally theta-rich alert signal stays below 20 after calibration',()=>{
    const estimator=calibrated();let result=estimator.update(awake,21000,true);
    for(let i=22;i<120;i++)result=estimator.update(awake,i*1000,true);
    expect(result.score).toBeLessThan(20);
    expect(result.status).toBe('awake-like');
  });
  test('alpha-only closed-eye relaxation is not drowsiness and baseline stays frozen',()=>{
    const estimator=calibrated();let result=estimator.update(awake,21000,true);
    const original=result.baselineThetaBetaRatio;
    for(let i=22;i<100;i++)result=estimator.update(metrics(.15,.7,.1),i*1000,true);
    expect(result.score).toBeLessThan(20);
    expect(result.status).toBe('relaxed');
    expect(result.baselineThetaBetaRatio).toBe(original);
  });
  test('requires sustained rises in both theta ratios, rejects brief excursions',()=>{
    const estimator=calibrated();let result=estimator.update(awake,21000,true);
    for(let i=22;i<=25;i++)result=estimator.update(metrics(.7,.12,.1),i*1000,true);
    expect(result.score).toBe(10);
    for(let i=26;i<32;i++)result=estimator.update(awake,i*1000,true);
    for(let i=32;i<60;i++)result=estimator.update(metrics(.7,.12,.1),i*1000,true);
    expect(result.score).toBeGreaterThan(70);
    expect(result.status).toBe('drowsy-change');
    const last=result.score;
    result=estimator.update(metrics(.9,.01,.01),61000,false);
    expect(result.score).toBe(last);
    expect(result.status).toBe('quality-hold');
  });
});
