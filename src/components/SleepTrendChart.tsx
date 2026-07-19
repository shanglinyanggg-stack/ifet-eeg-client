import type { CSSProperties } from 'react';
import { computeDrowsinessScore } from '../domain/drowsiness';
import type { SleepMetrics } from '../domain/sleep-metrics';
import type { DrowsinessMode } from '../domain/settings';
import type { WearableDrowsinessSnapshot } from '../domain/wearable-drowsiness';

interface SleepTrendChartProps {
  metrics: SleepMetrics;
  sleepProbability?: number | null;
  realtimeStage?: string;
  drowsinessMode?: DrowsinessMode;
  drowsinessEstimate?: WearableDrowsinessSnapshot | null;
}

export function SleepTrendChart({
  metrics,
  sleepProbability,
  realtimeStage = '等待分期',
  drowsinessMode = 'v025',
  drowsinessEstimate = null
}: SleepTrendChartProps) {
  const useWearableTrial = drowsinessMode === 'wearable-trial' && drowsinessEstimate !== null;
  const drowsiness = useWearableTrial
    ? drowsinessEstimate.score
    : computeDrowsinessScore(metrics, sleepProbability);
  const ringStyle = {
    '--sleep-score-angle': `${drowsiness * 3.6}deg`
  } as CSSProperties;

  return (
    <section className="panel sleep-trend-panel" aria-label="困意值">
      <div className="panel-header">
        <h2>困意值</h2>
        <span className="panel-meta">{useWearableTrial ? '可穿戴试验' : '实时检测'}</span>
      </div>
      <div className="sleep-trend-body">
        <div
          className="sleep-score-ring"
          style={ringStyle}
          aria-label={`困意值 ${drowsiness}%，数值越高越困`}
        >
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
          <small>{useWearableTrial
            ? drowsinessEstimate.baselineReady
              ? `${wearableSourceLabel(drowsinessEstimate.source)} · ${trendLabel(metrics.solTrend)}`
              : `清醒基线 ${Math.round(drowsinessEstimate.baselineProgress * 100)}% · 暂用 0.2.5`
            : `实时 · 0.2.5 算法 · ${trendLabel(metrics.solTrend)}`}</small>
        </div>
      </div>
    </section>
  );
}

function wearableSourceLabel(source: WearableDrowsinessSnapshot['source']): string {
  if (source === 'quality-hold') return '低质量保持';
  if (source === 'spectral-only') return '可穿戴频谱';
  if (source === 'wearable-fusion') return '频谱 + PC 融合';
  return '可穿戴试验';
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
