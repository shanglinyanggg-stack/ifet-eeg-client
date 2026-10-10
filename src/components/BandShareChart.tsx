import type { BandShare } from '../domain/dsp';
import { formatBandSharePercent } from '../domain/band-share-display';

interface BandShareChartProps {
  shares: BandShare[];
  colors: Record<string, string>;
  mode?: string | null;
  visualState?: string | null;
  visualConfidence?: number | null;
}

export function BandShareChart({
  shares,
  colors,
  mode,
  visualState,
  visualConfidence
}: BandShareChartProps) {
  const visual = mode === 'state_enhanced_visual_index';
  let start = 0;
  const hasEnergy = shares.some((share) => share.percent > 0);
  const segments = shares.map((share) => {
    const angle = (share.percent / 100) * 360;
    const segment = `${colors[share.label] ?? '#64748b'} ${start}deg ${start + angle}deg`;
    start += angle;
    return segment;
  });
  const background = hasEnergy ? `conic-gradient(${segments.join(', ')})` : 'var(--surface-elevated)';

  return (
    <section className="panel share-panel" aria-label={visual ? '状态增强视觉占比' : '脑电频带占比'}>
      <div className="panel-header">
        <h2>{visual ? '状态增强视觉占比' : '频带占比'}</h2>
        <span className="panel-meta">
          {visual
            ? `交互/分期映射 · 非真实功率 · ${visualStateLabel(visualState)}${visualConfidence == null ? '' : ` ${Math.round(visualConfidence * 100)}%`}`
            : '中位参考 · 模板匹配 · 清醒1/f校正'}
        </span>
      </div>
      <div className="share-body">
        <div className="donut" style={{ background }} aria-label={visual ? '状态增强视觉占比饼图' : '频带能量占比饼图'}>
          <span className="donut-core">{visual ? '视觉' : 'EEG'}</span>
        </div>
        <ul className="share-list" aria-label={visual ? '状态增强视觉占比明细' : '频带占比明细'}>
          {shares.map((share) => (
            <li className="share-row" key={share.label}>
              <span className="legend-dot" style={{ backgroundColor: colors[share.label] }} />
              <span>{share.label}</span>
              <strong>{formatBandSharePercent(share.label, share.percent)}</strong>
              <span className="share-meter" aria-hidden="true">
                <span style={{ width: `${share.percent}%`, backgroundColor: colors[share.label] }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function visualStateLabel(state: string | null | undefined): string {
  if (state === 'eyes_closed') return '闭眼增强';
  if (state === 'deep_sleep_candidate') return '深睡候选增强';
  return '睁眼增强';
}
