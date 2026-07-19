import type { SleepMetrics } from '../domain/sleep-metrics';

interface SleepMetricsPanelProps {
  metrics: SleepMetrics;
}

export function SleepMetricsPanel({ metrics }: SleepMetricsPanelProps) {
  const n2Detail = [
    metrics.spindleCandidate ? '纺锤波' : '',
    metrics.kComplexCandidate ? 'K 复合波' : ''
  ].filter(Boolean).join(' / ');

  return (
    <section className="panel sleep-metrics-panel" aria-label="睡眠指标">
      <div className="panel-header">
        <h2>睡眠指标</h2>
        <span className="panel-meta">{trendLabel(metrics.solTrend)}</span>
      </div>
      <div className="sleep-metrics-body">
        <MetricTile label="SOL 入睡潜伏期" value={formatSol(metrics.solSeconds)} hint="当前窗口估计" />
        <MetricTile label="θ/α 比值" value={formatRatio(metrics.thetaAlphaRatio)} hint={ratioHint(metrics.thetaAlphaRatio)} />
        <BandMetric label="α 相对功率" value={metrics.alphaRelative} />
        <BandMetric label="θ 相对功率" value={metrics.thetaRelative} />
        <BandMetric label="β 相对功率" value={metrics.betaRelative} />
        <MetricTile label="是否出现顶尖波" value={metrics.vertexWave ? '出现' : '未见'} tone={metrics.vertexWave ? 'positive' : 'neutral'} />
        <MetricTile
          label="是否进入 N2"
          value={metrics.n2Candidate ? '候选' : '未见'}
          hint={n2Detail || '纺锤波 / K 复合波'}
          tone={metrics.n2Candidate ? 'positive' : 'neutral'}
        />
      </div>
    </section>
  );
}

function BandMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="sleep-metric-tile sleep-band-tile">
      <div className="sleep-metric-label">{label}</div>
      <div className="sleep-metric-value">{formatPercent(value)}</div>
      <div className="sleep-meter" aria-hidden="true">
        <span style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  hint,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'positive';
}) {
  return (
    <div className={`sleep-metric-tile is-${tone}`}>
      <div className="sleep-metric-label">{label}</div>
      <div className="sleep-metric-value">{value}</div>
      {hint && <div className="sleep-metric-hint">{hint}</div>}
    </div>
  );
}

function trendLabel(trend: SleepMetrics['solTrend']): string {
  if (trend === 'sleep-onset') return '入睡线索';
  if (trend === 'transition') return '过渡期';
  return '清醒线索';
}

function ratioHint(value: number): string {
  if (value >= 1.1) return 'θ 活动占优';
  if (value >= 0.75) return '接近过渡';
  return 'α 相对占优';
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function formatSol(value: number | null): string {
  if (value === null) return '未出现';
  if (value >= 60) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return `${value.toFixed(1)}s`;
}
