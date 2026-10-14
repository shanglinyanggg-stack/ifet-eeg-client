import type {TimedValue} from './dsp';

/** Binary searches a monotonic acquisition timebase; never changes its rate. */
export function lowerTimestamp(values:TimedValue[],timestamp:number,strict=false):number {
  let low=0,high=values.length;
  while(low<high){const middle=(low+high)>>>1;
    if(values[middle].timestamp<timestamp||(strict&&values[middle].timestamp===timestamp))low=middle+1;
    else high=middle;}
  return low;
}
export function timeWindow(values:TimedValue[],start:number,end=Infinity):TimedValue[] {
  return values.slice(lowerTimestamp(values,start),lowerTimestamp(values,end,true));
}

/** Presentation only: invalid flags remain invalid, and the raw array is not mutated.
 * Do not use these points for PSD, controls, recording, LSL or packet-loss metrics. */
export function interpolateDisplayGaps(source:TimedValue[],maximumMs=100):TimedValue[] {
  let result:TimedValue[]|null=null;
  const invalid=(point:TimedValue)=>point.valid===false||point.observed===false||!Number.isFinite(point.value);
  for(let start=0;start<source.length;start++){
    if(!invalid(source[start]))continue;
    let end=start+1;while(end<source.length&&invalid(source[end]))end++;
    const left=source[start-1],right=source[end];
    if(left&&right&&!invalid(left)&&!invalid(right)&&right.timestamp>left.timestamp
      &&right.timestamp-left.timestamp<=maximumMs){
      result??=source.slice();
      for(let index=start;index<end;index++){
        const fraction=(source[index].timestamp-left.timestamp)/(right.timestamp-left.timestamp);
        result[index]={...source[index],value:left.value+(right.value-left.value)*fraction,valid:false,interpolated:true};
      }
    }
    start=end-1;
  }
  return result??source;
}

/** Every native-rate sample contributes to a pixel-column envelope. This is
 * raster aggregation, not sampling-rate conversion or periodic sample skipping. */
export function rasterizeWaveform(values:TimedValue[],start:number,end:number,width:number,interpolate=false):{points:TimedValue[];maxAbs:number} {
  const points:TimedValue[]=[];let maxAbs=0,bucket=-1,kind=-1;
  let first:TimedValue|null=null,last:TimedValue|null=null,min:TimedValue|null=null,max:TimedValue|null=null;
  const flush=()=>{
    if(!first)return;
    const candidates=kind===2?[first]:[first,min!,max!,last!].sort((a,b)=>a.timestamp-b.timestamp);
    for(const point of candidates)if(points[points.length-1]!==point)points.push(point);
  };
  const columns=Math.max(1,Math.ceil(width)),span=Math.max(1,end-start);
  const steps=values.slice(1,Math.min(32,values.length)).map((point,index)=>point.timestamp-values[index].timestamp).filter(value=>value>0).sort((a,b)=>a-b);
  const expected=steps[Math.floor(steps.length/2)]??Infinity;
  let previous:TimedValue|undefined;
  for(const point of values){
    if(previous&&point.timestamp-previous.timestamp>expected*3){
      flush();first=null;bucket=-1;kind=-1;
      const canInterpolate=interpolate&&point.timestamp-previous.timestamp<=100&&previous.valid!==false&&point.valid!==false
        &&Number.isFinite(previous.value)&&Number.isFinite(point.value);
      points.push({timestamp:(previous.timestamp+point.timestamp)/2,value:canInterpolate?(previous.value+point.value)/2:NaN,valid:false,interpolated:canInterpolate});
    }
    const finite=Number.isFinite(point.value)&&((point.valid!==false&&point.observed!==false)||point.interpolated===true);
    const nextKind=!finite?2:point.interpolated?1:0;
    const nextBucket=Math.min(columns-1,Math.max(0,Math.floor((point.timestamp-start)/span*columns)));
    if(finite)maxAbs=Math.max(maxAbs,Math.abs(point.value));
    if(nextBucket!==bucket||nextKind!==kind){flush();bucket=nextBucket;kind=nextKind;first=last=min=max=point;}
    else{last=point;if(finite){if(point.value<min!.value)min=point;if(point.value>max!.value)max=point;}}
    previous=point;
  }
  flush();return {points,maxAbs};
}
