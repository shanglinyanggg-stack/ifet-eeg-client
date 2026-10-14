import {memo,useCallback,useEffect,useRef,type CSSProperties} from 'react';
import {smoothAutoScale,type TimedValue} from '../domain/dsp';
import {interpolateDisplayGaps,rasterizeWaveform} from '../domain/display-window';
import {useStimulusMarkers} from '../domain/stimulus-markers';
import {formatAxisNumber,formatClockAxis,signalDisplayUnit,timeAxisTicks} from '../domain/signal-display';
import {useSignalDisplay} from './SignalDisplayProvider';
export interface WaveformSeries {label:string;color:string;values:TimedValue[];scale?:number}
export interface SideLabel {text:string;color:string;sub?:string}
interface WaveformCanvasProps {
  title:string;series:WaveformSeries[];height?:number|string;fill?:boolean;emptyText?:string;
  sideLabel?:SideLabel;labelAlign?:'legend'|'right';gridStyle?:'lines'|'dots';
}
const MARGIN={left:62,right:16,top:18,bottom:24};
function WaveformCanvasView({title,series,height=220,fill=false,emptyText='等待数据',sideLabel,
  labelAlign='legend',gridStyle='lines'}:WaveformCanvasProps){
  const display=useSignalDisplay(),markers=useStimulusMarkers();
  const canvasRef=useRef<HTMLCanvasElement|null>(null),frame=useRef<number|null>(null);
  const fallback=useRef<ReturnType<typeof setTimeout>|null>(null);
  const drawRef=useRef(()=>undefined as void),autoScale=useRef<number|undefined>(undefined);
  const visible=useRef(true),styleCache=useRef<CSSStyleDeclaration|null>(null),rectCache=useRef<DOMRect|null>(null);
  const schedule=useCallback(()=>{
    if(!visible.current)return;
    if(frame.current!==null)return;
    const draw=()=>{if(fallback.current!==null){clearTimeout(fallback.current);fallback.current=null;}frame.current=null;drawRef.current();};
    frame.current=requestAnimationFrame(draw);
    // WKWebView can pause RAF while unfocused even though BLE/React continue.
    // A bounded fallback keeps the newest plot ready without a queued RAF backlog.
    fallback.current=setTimeout(()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);draw();},250);
  },[]);
  const unit=signalDisplayUnit(series[0]?.label??title,display),bounds=signalBounds(series);
  const latest=series.map(item=>{const point=item.values[item.values.length-1],itemUnit=signalDisplayUnit(item.label,display);
    return point&&Number.isFinite(point.value)?`${item.label} ${formatAxisNumber(point.value*itemUnit.factor)} ${itemUnit.label}`:null;
  }).filter(Boolean).slice(0,2).join(' · ');
  drawRef.current=()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    if(!visible.current)return;
    const rect=rectCache.current??(rectCache.current=canvas.getBoundingClientRect()),dpr=window.devicePixelRatio||1;
    if(rect.width<=0||rect.height<=0)return;
    const width=Math.max(1,rect.width),height=Math.max(1,rect.height);
    const pixelWidth=Math.max(1,Math.floor(width*dpr)),pixelHeight=Math.max(1,Math.floor(height*dpr));
    if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight;}
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const style=styleCache.current??(styleCache.current=getComputedStyle(canvas)),muted=style.getPropertyValue('--text-muted').trim()||'#94a3b8';
    const background=style.getPropertyValue('--chart-bg').trim()||'#0c1420',grid=style.getPropertyValue('--chart-grid').trim()||'rgba(148,163,184,.13)';
    const plotWidth=Math.max(1,width-MARGIN.left-MARGIN.right),plotHeight=Math.max(1,height-MARGIN.top-MARGIN.bottom);
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
    const rasters=series.map(item=>{const values=display.interpolateGaps?interpolateDisplayGaps(item.values):item.values;
      return bounds?rasterizeWaveform(values,bounds.start,bounds.end,plotWidth,display.interpolateGaps):{points:[],maxAbs:0};});
    let maxAbs=0,explicit=false;
    series.forEach((item,index)=>{if(typeof item.scale==='number'&&item.scale>0){maxAbs=Math.max(maxAbs,item.scale);explicit=true;}
      else maxAbs=Math.max(maxAbs,rasters[index].maxAbs*1.15);});
    if(!(maxAbs>0))maxAbs=1;
    if(!explicit){maxAbs=smoothAutoScale(autoScale.current,maxAbs);autoScale.current=maxAbs;}else autoScale.current=undefined;
    const ticks=bounds?timeAxisTicks(bounds.start,bounds.end,plotWidth,display.timeAxis):[];
    ctx.save();ctx.translate(MARGIN.left,MARGIN.top);ctx.strokeStyle=grid;ctx.lineWidth=1;
    for(let i=0;i<=4;i++){const y=plotHeight*i/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(plotWidth,y);ctx.stroke();}
    for(const tick of ticks){const x=tick.fraction*plotWidth;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();}
    if(gridStyle==='dots'){ctx.fillStyle=grid;for(let y=20;y<plotHeight;y+=24)for(let x=20;x<plotWidth;x+=28)ctx.fillRect(x,y,1,1);}
    ctx.beginPath();ctx.rect(0,0,plotWidth,plotHeight);ctx.clip();
    if(bounds){const span=Math.max(1,bounds.end-bounds.start);let legendX=6;
      for(let index=0;index<series.length;index++){const item=series[index],points=rasters[index].points;
        const x=(point:TimedValue)=>(point.timestamp-bounds.start)/span*plotWidth;
        const y=(point:TimedValue)=>(point.valid===false||point.observed===false)&&!point.interpolated?NaN:plotHeight/2-point.value/maxAbs*(plotHeight*.5);
        const color=resolveColor(style,item.color);
        if(points.length>1&&points.length<=2048&&points.every(point=>point.valid!==false&&point.observed!==false&&Number.isFinite(point.value))){
          const gradient=ctx.createLinearGradient(0,0,0,plotHeight);gradient.addColorStop(0,colorWithAlpha(color,.11));gradient.addColorStop(1,colorWithAlpha(color,0));
          ctx.beginPath();ctx.moveTo(x(points[0]),y(points[0]));for(let i=1;i<points.length;i++)ctx.lineTo(x(points[i]),y(points[i]));
          ctx.lineTo(x(points[points.length-1]),plotHeight);ctx.lineTo(x(points[0]),plotHeight);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();}
        ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.25;ctx.lineJoin='round';ctx.lineCap='round';let drawing=false;
        let previous:TimedValue|null=null,dashed=false,runLength=0;
        const isolated=()=>{if(previous&&runLength===1){ctx.fillStyle=color;ctx.fillRect(x(previous)-.75,y(previous)-.75,1.5,1.5);}};
        for(const point of points){const py=y(point);
          if(!Number.isFinite(py)){isolated();drawing=false;previous=null;runLength=0;continue;}
          const nextDashed=!!point.interpolated||!!previous?.interpolated;
          if(nextDashed!==dashed){ctx.stroke();ctx.beginPath();ctx.setLineDash(nextDashed?[4,3]:[]);dashed=nextDashed;
            if(previous&&drawing)ctx.moveTo(x(previous),y(previous));}
          if(drawing){ctx.lineTo(x(point),py);runLength++;}else{ctx.moveTo(x(point),py);drawing=true;runLength=1;}
          previous=point;
        }isolated();ctx.stroke();ctx.setLineDash([]);
        ctx.font='10px system-ui';ctx.fillStyle=color;ctx.textAlign='left';
        if(labelAlign==='right'){let last:TimedValue|undefined;for(let i=points.length-1;i>=0;i--)if(Number.isFinite(y(points[i]))){last=points[i];break;}
          if(last)ctx.fillText(item.label,Math.max(0,plotWidth-65),Math.max(12,Math.min(plotHeight-3,y(last))));}
        else{ctx.fillText(item.label,legendX,12);legendX+=ctx.measureText(item.label).width+18;}}
      for(const marker of markers){if(marker.timestamp<bounds.start||marker.timestamp>bounds.end)continue;
        const x=(marker.timestamp-bounds.start)/span*plotWidth;ctx.strokeStyle=marker.modality==='audio'?'#f59e0b':'#a78bfa';
        ctx.setLineDash(marker.edge==='start'?[4,3]:[2,3]);ctx.beginPath();ctx.moveTo(x,16);ctx.lineTo(x,plotHeight);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle=ctx.strokeStyle;ctx.font='10px system-ui';ctx.fillText(marker.label,Math.min(x+3,Math.max(0,plotWidth-70)),22);}
    }else{ctx.fillStyle=muted;ctx.font='12px system-ui';ctx.textAlign='center';ctx.fillText(emptyText,plotWidth/2,plotHeight/2);}
    ctx.restore();ctx.fillStyle=muted;ctx.font='10px system-ui';ctx.textAlign='right';
    for(let i=0;i<=4;i++)ctx.fillText(formatAxisNumber((1-i/2)*maxAbs*unit.factor),MARGIN.left-8,MARGIN.top+plotHeight*i/4+3);
    ctx.textAlign='left';ctx.fillText(unit.label,6,13);
    ticks.forEach((tick,index)=>{ctx.textAlign=index===0?'left':index===ticks.length-1?'right':'center';ctx.fillText(tick.label,MARGIN.left+tick.fraction*plotWidth,height-10);});
  };
  useEffect(()=>{const canvas=canvasRef.current;if(!canvas)return;
    const resize=()=>{rectCache.current=null;schedule();};
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null;observer?.observe(canvas);
    const intersection=typeof IntersectionObserver!=='undefined'?new IntersectionObserver(entries=>{visible.current=entries.some(entry=>entry.isIntersecting);if(visible.current)schedule();}):null;intersection?.observe(canvas);
    const redraw=()=>{styleCache.current=null;rectCache.current=null;schedule();};
    const themeObserver=new MutationObserver(redraw);themeObserver.observe(canvas.closest('.app-shell')??document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});
    window.addEventListener('focus',redraw);document.addEventListener('visibilitychange',redraw);
    return()=>{observer?.disconnect();intersection?.disconnect();themeObserver.disconnect();window.removeEventListener('focus',redraw);document.removeEventListener('visibilitychange',redraw);
      if(fallback.current!==null){clearTimeout(fallback.current);fallback.current=null;}if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}};
  },[schedule]);
  useEffect(()=>{schedule();});
  const timeCaption=bounds?`${formatClockAxis(bounds.start)}–${formatClockAxis(bounds.end)}`:'等待时间数据';
  return <section className={`panel waveform-panel ${fill?'fill-panel ':''}${sideLabel?'side-label-panel':''}`} aria-label={title}>
    {sideLabel?<div className="side-label" style={{'--side-color':sideLabel.color} as CSSProperties}>
      <span className="side-label-symbol">{sideLabel.text}</span>{sideLabel.sub&&<span className="side-label-sub">{sideLabel.sub}</span>}
      <span className="side-label-value">{unit.label}</span></div>:
      <div className="panel-header"><h2>{title}</h2>{latest&&<span className="panel-meta">{latest}</span>}</div>}
    <div className="waveform-plot" style={fill||sideLabel?undefined:{height}}>
      <canvas ref={canvasRef} role="img" aria-label={`${title} · 横轴${display.timeAxis==='clock'?'本地时间':'相对当前秒数'} · 纵轴${unit.label}`}/>
      <span className="sr-only waveform-axis-caption">{timeCaption}；纵轴单位{unit.label}</span>
      {display.interpolateGaps&&<span className="waveform-interpolation-label">短断点插值 · 虚线</span>}
    </div>
  </section>;
}
export const WaveformCanvas=memo(WaveformCanvasView,(previous,next)=>
  previous.title===next.title&&previous.height===next.height&&previous.fill===next.fill&&previous.emptyText===next.emptyText
  &&previous.labelAlign===next.labelAlign&&previous.gridStyle===next.gridStyle
  &&previous.sideLabel?.text===next.sideLabel?.text&&previous.sideLabel?.color===next.sideLabel?.color&&previous.sideLabel?.sub===next.sideLabel?.sub
  &&previous.series.length===next.series.length&&previous.series.every((item,index)=>{
    const other=next.series[index];return item.values===other.values&&item.label===other.label&&item.color===other.color&&item.scale===other.scale;}));
function signalBounds(series:WaveformSeries[]):{start:number;end:number}|null{
  let start=Infinity,end=-Infinity;for(const item of series){if(!item.values.length)continue;start=Math.min(start,item.values[0].timestamp);end=Math.max(end,item.values[item.values.length-1].timestamp);}
  return Number.isFinite(start)&&Number.isFinite(end)?{start,end}:null;
}
export function resolveCanvasPointLimit(width:number):number{return Math.max(160,Math.min(2000,Math.ceil(width*2)));}
function resolveColor(style:CSSStyleDeclaration,color:string):string{
  const match=color.match(/^var\((--[^,)]+)(?:,\s*([^)]+))?\)$/);return match?(style.getPropertyValue(match[1]).trim()||match[2]||'#5eead4'):color;
}
function colorWithAlpha(color:string,alpha:number):string{
  const hex=color.match(/^#([\da-f]{6})$/i);if(!hex)return 'rgba(94,234,212,.035)';
  return `rgba(${parseInt(hex[1].slice(0,2),16)},${parseInt(hex[1].slice(2,4),16)},${parseInt(hex[1].slice(4,6),16)},${alpha})`;
}
