import type { CSSProperties } from 'react';
import type { SleepMetrics } from '../domain/sleep-metrics';

interface SleepTrendChartProps {
  metrics: SleepMetrics;
  sleepProbability?: number | null;
  realtimeStage?: string;
}

export function SleepTrendChart({ metrics, sleepProbability, realtimeStage = '等待分期' }: SleepTrendChartProps) {
  const drowsiness = sleepProbability === null || sleepProbability === undefined
    ? metrics.sleepOnsetScore
    : Math.round(Math.max(0, Math.min(1, sleepProbability)) * 100);
  const ringStyle = {
    '--sleep-score-angle': `${drowsiness * 3.6}deg`
  } as CSSProperties;

  return (
    <section className="panel sleep-trend-panel" aria-label="困意值">
      <div className="panel-header">
        <h2>困意值</h2>
        <span className="panel-meta">{trendLabel(metrics.solTrend)}</span>
      </div>
      <div className="sleep-trend-body">
        <div className="sleep-score-ring" style={ringStyle} aria-label={`困意值 ${drowsiness}%，数值越高越困`}>
          <div className="sleep-score-core">
            <strong>{drowsiness}</strong>
            <span>%</span>
          </div>
        </div>
        <div className="sleep-trend-stats">
          <span>
            θ/α <strong>{formatRatio(metrics.thetaAlphaRatio)}</strong>
          </span>
          <span>
            分期 <strong>{realtimeStage}</strong>
          </span>
        </div>
      </div>
    </section>
  );
}

function trendLabel(trend: SleepMetrics['solTrend']): string {
  if (trend === 'sleep-onset') return '入睡线索';
  if (trend === 'transition') return '过渡期';
  return '清醒线索';
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
