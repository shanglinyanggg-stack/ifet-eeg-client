import {RingBuffer,type TimedValue} from './dsp';
/** Full-rate 65s history is retained once. React only receives the currently
 * needed tail, so a 10s viewport does not copy 65s x 13 channels every 100ms. */
export class NativeDisplayHistory<K extends string>{
  private rate=0;private histories=new Map<K,RingBuffer<TimedValue>>();
  constructor(private channels:K[],private seconds=65){}
  append(pending:Record<K,TimedValue[]>,rate:number){
    if(this.rate!==rate){this.rate=rate;this.histories=new Map(this.channels.map(key=>[key,new RingBuffer<TimedValue>(rate*this.seconds)]));}
    for(const key of this.channels)for(const point of pending[key])this.histories.get(key)!.push(point);
  }
  snapshot(seconds:number):Record<K,TimedValue[]>{
    return Object.fromEntries(this.channels.map(key=>[key,this.histories.get(key)?.toArray(this.rate*seconds)??[]])) as Record<K,TimedValue[]>;
  }
  get maxRetainedPoints(){return Math.max(0,...Array.from(this.histories.values(),history=>history.length));}
  reset(){this.rate=0;this.histories.clear();}
}
export function displaySnapshotSeconds(window:number|'auto',delayMs:number){
  return Math.min(65,Math.max(10.5,(typeof window==='number'?window:10)+Math.max(0,Math.min(5000,delayMs))/1000+.5));
}
