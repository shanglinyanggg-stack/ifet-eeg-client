import type { SleepMetrics } from './sleep-metrics';
import type { WearableDrowsinessSnapshot } from './wearable-drowsiness';
import { quantile } from './robust-eeg';

type Features={thetaBeta:number;thetaAlpha:number;beta:number};
export interface PersonalDrowsinessSnapshot extends WearableDrowsinessSnapshot {
  status:'uncalibrated'|'calibrating'|'awake-like'|'relaxed'|'drowsy-change'|'quality-hold';
  calibrationActive:boolean;
  reason:string;
}
export function emptyPersonalDrowsinessSnapshot():PersonalDrowsinessSnapshot {
  return {score:0,featureScore:null,modelScore:null,baselineProgress:0,baselineReady:false,
    qualityAccepted:false,source:'personal-baseline',thetaBetaRatio:0,slowFastRatio:0,baselineThetaBetaRatio:null,
    status:'uncalibrated',calibrationActive:false,reason:'先测量20秒睁眼清醒基线；困意指数不是睡眠概率'};
}

/** A conservative relative change index, NOT a fitted clinical classifier.
 * Requires user-confirmed alert calibration. Staging probability is deliberately
 * not treated as drowsiness; alpha-only eyes-closed relaxation cannot raise it. */
export class PersonalDrowsinessEstimator {
  private baseline:Features[]=[];
  private elapsed=0;
  private lastTime=-Infinity;
  private candidateSeconds=0;
  private active=false;
  private result=emptyPersonalDrowsinessSnapshot();
  private evidence:number[]=[];
  startCalibration(timestampMs:number):PersonalDrowsinessSnapshot {
    this.reset();this.active=true;this.lastTime=timestampMs;
    this.result={...this.result,status:'calibrating',calibrationActive:true,reason:'保持睁眼、清醒、安静20秒；伪迹期间暂停计时'};
    return this.result;
  }
  reset(){this.baseline=[];this.elapsed=0;this.lastTime=-Infinity;this.candidateSeconds=0;
    this.active=false;this.evidence=[];this.result=emptyPersonalDrowsinessSnapshot();}
  update(metrics:SleepMetrics,timestampMs:number,qualityAccepted:boolean):PersonalDrowsinessSnapshot {
    if(timestampMs-this.lastTime<950)return this.result;
    const dt=Number.isFinite(this.lastTime)?Math.max(0,Math.min(1.5,(timestampMs-this.lastTime)/1000)):0;
    this.lastTime=timestampMs;
    const features=extract(metrics);
    if(!qualityAccepted||!features){this.candidateSeconds=0;
      this.result={...this.result,qualityAccepted:false,status:this.active?'calibrating':'quality-hold',
        reason:this.active?'信号质量不足，基线计时暂停':'信号质量不足，保持上次指数，不作困倦判定'};
      return this.result;}
    if(this.active){
      this.elapsed+=dt;this.baseline.push(features);
      if(this.elapsed>=20&&this.baseline.length>=12){this.active=false;}
      this.result={...this.result,score:10,qualityAccepted:true,baselineProgress:Math.min(1,this.elapsed/20),
        baselineReady:!this.active,calibrationActive:this.active,status:this.active?'calibrating':'awake-like',
        reason:this.active?`睁眼清醒基线：${this.elapsed.toFixed(1)}/20秒有效数据`:'清醒基线已冻结；闭眼不会更新基线',
        thetaBetaRatio:Math.exp(features.thetaBeta),slowFastRatio:(metrics.thetaRelative+metrics.alphaRelative)/Math.max(metrics.betaRelative,1e-6),
        baselineThetaBetaRatio:Math.exp(quantile(this.baseline.map(item=>item.thetaBeta),0.5))};
      return this.result;
    }
    if(!this.result.baselineReady){this.result={...this.result,qualityAccepted:true,status:'uncalibrated',
      reason:'信号有效；请先测量20秒睁眼清醒基线，困意指数不是睡眠概率'};return this.result;}
    const median=(key:keyof Features)=>quantile(this.baseline.map(item=>item[key]),0.5);
    const z=(key:keyof Features)=>Math.max(0,(features[key]-median(key))/Math.max(0.25,
      (quantile(this.baseline.map(item=>item[key]),0.75)-quantile(this.baseline.map(item=>item[key]),0.25))*1.5));
    const thetaBeta=z('thetaBeta'),thetaAlpha=z('thetaAlpha');
    const betaDrop=Math.max(0,(median('beta')-features.beta)/Math.max(0.03,median('beta')));
    // Both ratios must rise: isolated alpha reactivity, broadband drift or a
    // naturally theta-rich alert baseline are not sufficient evidence.
    const directional=Math.min(thetaBeta,thetaAlpha)*(0.7+0.3*Math.min(1,betaDrop));
    this.evidence.push(directional);if(this.evidence.length>5)this.evidence.shift();
    const sustained=quantile(this.evidence,0.5);
    this.candidateSeconds=sustained>=0.75?this.candidateSeconds+dt:0;
    const qualified=this.candidateSeconds>=8;
    const target=qualified?10+90*(1-Math.exp(-Math.max(0,sustained-0.5)*0.65)):10;
    const score=Math.round(this.result.score+(target-this.result.score)*(1-Math.exp(-dt/3)));
    const relaxed=metrics.alphaRelative>0.5&&thetaAlpha<0.25;
    this.result={...this.result,score,featureScore:Math.round(target),qualityAccepted:true,
      status:qualified?'drowsy-change':relaxed?'relaxed':'awake-like',
      reason:qualified?'相对清醒基线的慢化持续≥8秒；仍需主观标签验证':relaxed?'Alpha增强：闭眼/放松线索，不直接判困倦':'未见持续困倦变化',
      thetaBetaRatio:Math.exp(features.thetaBeta),slowFastRatio:(metrics.thetaRelative+metrics.alphaRelative)/Math.max(metrics.betaRelative,1e-6)};
    return this.result;
  }
}
function extract(metrics:SleepMetrics):Features|null {
  const {thetaRelative:theta,alphaRelative:alpha,betaRelative:beta}=metrics;
  if(![theta,alpha,beta].every(Number.isFinite)||theta<0||alpha<0||beta<=1e-6)return null;
  return {thetaBeta:Math.log(Math.max(theta,1e-6)/beta),thetaAlpha:Math.log(Math.max(theta,1e-6)/Math.max(alpha,1e-6)),beta};
}
