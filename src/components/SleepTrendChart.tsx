import type { CSSProperties } from 'react';
import type { SleepMetrics } from '../domain/sleep-metrics';

interface SleepTrendChartProps {
  metrics: SleepMetrics;
}

export function SleepTrendChart({ metrics }: SleepTrendChartProps) {
  const ringStyle = {
    '--sleep-score-angle': `${metrics.sleepOnsetScore * 3.6}deg`
  } as CSSProperties;

  return (
    <section className="panel sleep-trend-panel" aria-label="困意值">
      <div className="panel-header">
        <h2>困意值</h2>
        <span className="panel-meta">{trendLabel(metrics.solTrend)}</span>
      </div>
      <div className="sleep-trend-body">
        <div className="sleep-score-ring" style={ringStyle} aria-label={`困意值 ${metrics.sleepOnsetScore}%，数值越高越困`}>
          <div className="sleep-score-core">
            <strong>{metrics.sleepOnsetScore}</strong>
            <span>%</span>
          </div>
        </div>
        <div className="sleep-trend-stats">
          <span>
            θ/α <strong>{formatRatio(metrics.thetaAlphaRatio)}</strong>
          </span>
          <span>
            N2 <strong>{metrics.n2Candidate ? '候选' : '未见'}</strong>
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
