import { useId, useMemo,useState } from 'react';
import {Maximize2,X} from 'lucide-react';
import type { TimedValue } from '../domain/dsp';
import { computeRelativePowerSpectrum } from '../domain/power-spectrum';
import type { RobustEegSnapshot } from '../domain/robust-eeg';
import {formatClockAxis} from '../domain/signal-display';

interface SpectrumChartProps {
  values: TimedValue[];
  sampleRateHz: number;
  channelLabel: string;
  analysis?: RobustEegSnapshot;
}

const WIDTH = 520;
const HEIGHT = 380;
const MARGIN = { left: 52, right: 18, top: 18, bottom: 42 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const FREQUENCY_TICKS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45];
const POWER_TICKS = [0, -20, -40, -60];
const SPECTRUM_BANDS = [
  { label: 'δ', low: 0.5, high: 4, color: '#1d4ed8' },
  { label: 'θ', low: 4, high: 8, color: '#7dd3fc' },
  { label: 'α', low: 8, high: 13, color: '#f59e0b' },
  { label: 'β', low: 13, high: 30, color: '#ef4444' },
  { label: 'γ', low: 30, high: 45, color: '#f472b6' }
];

export function SpectrumChart({
  values,
  sampleRateHz,
  channelLabel,
  analysis
}: SpectrumChartProps) {
  const [expanded,setExpanded]=useState(false);
  const gradientId = useId().replace(/:/g, '');
  const spectrum = useMemo(
    () => analysis ? analysis.displaySpectrum ?? analysis.spectrum ?? {points:[],peakFrequencyHz:null,resolutionHz:100/512,windowSeconds:8,fftSize:512,minimumDb:-60,maximumFrequencyHz:45}
      : computeRelativePowerSpectrum(values, sampleRateHz),
    [analysis, sampleRateHz, values]
  );
  const x = (frequencyHz: number) =>
    MARGIN.left + (frequencyHz / spectrum.maximumFrequencyHz) * PLOT_WIDTH;
  const y = (powerDb: number) =>
    MARGIN.top + ((0 - powerDb) / (0 - spectrum.minimumDb)) * PLOT_HEIGHT;
  const linePath = spectrum.points.map(
    (point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.frequencyHz).toFixed(2)} ${y(point.powerDb).toFixed(2)}`
  ).join(' ');
  const areaPath = spectrum.points.length > 0
    ? `${linePath} L ${x(spectrum.points[spectrum.points.length - 1].frequencyHz).toFixed(2)} ${y(spectrum.minimumDb)} L ${x(spectrum.points[0].frequencyHz).toFixed(2)} ${y(spectrum.minimumDb)} Z`
    : '';
  const peakPoint = spectrum.peakFrequencyHz === null
    ? null
    : spectrum.points.reduce((nearest, point) =>
      Math.abs(point.frequencyHz - Number(spectrum.peakFrequencyHz))
        < Math.abs(nearest.frequencyHz - Number(spectrum.peakFrequencyHz))
        ? point
        : nearest
    );

  return (
    <section className={`spectrum-chart ${expanded?'is-expanded':''}`} aria-label={`${channelLabel} 实时频谱`}>
      <div className="spectrum-tools"><span>{expanded?`${channelLabel} · 实时功率谱`:''}</span><button className="text-tool" aria-label={expanded?'关闭放大频谱':'放大频谱'} onClick={()=>setExpanded(value=>!value)}>
        {expanded?<X size={14}/>:<Maximize2 size={13}/>}<span>{expanded?'关闭':'放大频谱'}</span></button></div>
      <div className="spectrum-summary">
        <span>{analysis ? 'Welch分析窗' : 'FFT窗长'} <strong>{spectrum.points.length > 0 ? `${spectrum.windowSeconds.toFixed(2)} s` : '--'}</strong></span>
        <span>{analysis?`频率网格（${analysis.displaySegmentSeconds??4}s分段）`:'频率分辨率'} <strong>{spectrum.points.length > 0 ? `${spectrum.resolutionHz.toFixed(2)} Hz` : '--'}</strong></span>
        <span>峰值频率 <strong>{spectrum.peakFrequencyHz === null ? '--' : `${spectrum.peakFrequencyHz.toFixed(2)} Hz`}</strong></span>
        <span>范围 <strong>0.5–{spectrum.maximumFrequencyHz.toFixed(0)} Hz</strong></span>
        {analysis?.execution&&<span>计算位置 <strong>{analysis.execution==='worker'?'独立后台线程':'兼容主线程'}</strong></span>}
      </div>
      {analysis && <small>{analysis.reason} · 控制有效 {Math.round(analysis.cleanFraction*100)}%{analysis.held&&!analysis.displaySpectrum?' · 显示上次有效频谱':''}</small>}
      {spectrum.windowStartMs!==undefined&&spectrum.windowEndMs!==undefined&&<div className="analysis-time-axis" aria-label="频谱分析时间轴">
        <time>{formatClockAxis(spectrum.windowStartMs)}</time><span>分析窗 {spectrum.windowSeconds.toFixed(2)} s</span><time>{formatClockAxis(spectrum.windowEndMs)}</time></div>}
      {spectrum.points.length === 0 ? (
        <div className="spectrum-empty">{analysis ? analysis.reason : `等待至少 128 个 ${channelLabel} 样本`}</div>
      ) : (
        <svg
          className="spectrum-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${channelLabel} 0.5至${spectrum.maximumFrequencyHz.toFixed(0)}赫兹相对功率谱`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.38" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <rect
            className="spectrum-plot-bg"
            x={MARGIN.left}
            y={MARGIN.top}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
          />
          {SPECTRUM_BANDS.filter((band) => band.low < spectrum.maximumFrequencyHz).map((band) => {
            const low = Math.max(0, band.low);
            const high = Math.min(spectrum.maximumFrequencyHz, band.high);
            return (
              <g key={band.label}>
                <rect
                  x={x(low)}
                  y={MARGIN.top}
                  width={Math.max(0, x(high) - x(low))}
                  height={PLOT_HEIGHT}
                  fill={band.color}
                  opacity="0.055"
                />
                <text
                  className="spectrum-band-label"
                  x={(x(low) + x(high)) / 2}
                  y={MARGIN.top + 14}
                  textAnchor="middle"
                  fill={band.color}
                >
                  {band.label}
                </text>
              </g>
            );
          })}
          {POWER_TICKS.map((tick) => (
            <g key={tick}>
              <line
                className="spectrum-grid-line"
                x1={MARGIN.left}
                x2={MARGIN.left + PLOT_WIDTH}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="spectrum-axis-label" x={MARGIN.left - 8} y={y(tick) + 4} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}
          {FREQUENCY_TICKS.filter((tick) => tick <= spectrum.maximumFrequencyHz).map((tick) => (
            <g key={tick}>
              <line
                className="spectrum-grid-line is-vertical"
                x1={x(tick)}
                x2={x(tick)}
                y1={MARGIN.top}
                y2={MARGIN.top + PLOT_HEIGHT}
              />
              <text className="spectrum-axis-label" x={x(tick)} y={HEIGHT - 19} textAnchor="middle">
                {tick}
              </text>
            </g>
          ))}
          <path d={areaPath} fill={`url(#${gradientId})`} />
          <path className="spectrum-line" d={linePath} />
          {peakPoint && (
            <circle
              className="spectrum-peak"
              cx={x(peakPoint.frequencyHz)}
              cy={y(peakPoint.powerDb)}
              r="4"
            />
          )}
          <text className="spectrum-axis-title" x={MARGIN.left + PLOT_WIDTH / 2} y={HEIGHT - 3} textAnchor="middle">
            频率 (Hz)
          </text>
          <text
            className="spectrum-axis-title"
            transform={`translate(13 ${MARGIN.top + PLOT_HEIGHT / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            相对功率 (dB)
          </text>
        </svg>
      )}
    </section>
  );
}
