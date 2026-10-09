export interface ClockProbe { clientSend:number;clientReceive:number;hostTimeMs:number }
export function chooseVisualClock(probes:ClockProbe[]){
  const valid=probes.filter(p=>[p.clientSend,p.clientReceive,p.hostTimeMs].every(Number.isFinite)&&p.clientReceive>=p.clientSend);
  if(!valid.length)throw new Error('屏幕时钟同步失败');
  const best=valid.reduce((a,b)=>b.clientReceive-b.clientSend<a.clientReceive-a.clientSend?b:a);
  // WebView privacy settings can quantize performance.now() to 1 ms.
  // A zero measured round trip must not be presented as zero timing uncertainty.
  const uncertainty=Math.max(1,(best.clientReceive-best.clientSend)/2);
  if(uncertainty>10)throw new Error('屏幕与主机时钟同步不稳定，请重试');
  return{offsetMs:best.hostTimeMs-(best.clientSend+best.clientReceive)/2,uncertaintyMs:uncertainty};
}
