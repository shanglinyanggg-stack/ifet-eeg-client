import {RobustEegAnalyzer} from '../domain/robust-eeg';
import type {AnalysisRequest} from '../domain/eeg-analysis-client';
const analyzer=new RobustEegAnalyzer();
self.onmessage=(event:MessageEvent<AnalysisRequest>)=>{
  const request=event.data;
  const snapshot=analyzer.update(request.key,request.values,request.rate,request.ranges,request.context);
  self.postMessage({id:request.id,snapshot});
};
