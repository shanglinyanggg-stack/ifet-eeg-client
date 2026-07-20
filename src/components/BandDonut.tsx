import { formatBandSharePercent } from '../domain/band-share-display';

export interface DonutShare {
  symbol: string;
  label: string;
  percent: number;
  color: string;
}

interface BandDonutProps {
  shares: DonutShare[];
}

// 四象限实心饼图：每个扇区使用固定颜色，扇区内标注 α/β/γ/δ 符号，外侧标注百分比。
// 使用 SVG path 从圆心绘制填充扇形，呈现实心饼图而非环形。
export function BandDonut({ shares }: BandDonutProps) {
  const size = 188;
  const cx = size / 2;
  const cy = size / 2;
  const r = 66;
  const total = shares.reduce((sum, item) => sum + Math.max(0, item.percent), 0);
  const hasEnergy = total > 0;

  const polar = (deg: number, radius: number) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  };

  let cursor = -90;
  const segments = shares.map((share) => {
    const frac = hasEnergy ? Math.max(0, share.percent) / total : 0;
    const sweep = frac * 360;
    const startDeg = cursor;
    const endDeg = startDeg + sweep;
    const midDeg = startDeg + sweep / 2;
    cursor = endDeg;

    const start = polar(startDeg, r);
    const end = polar(endDeg, r);
    const largeArc = sweep > 180 ? 1 : 0;
    const path = `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
    const midRad = (midDeg * Math.PI) / 180;
    const seg = {
      key: share.symbol,
      color: share.color,
      symbol: share.symbol,
      label: share.label,
      percent: share.percent,
      path,
      // 扇区内符号：落在扇区中部约 0.62r 处
      innerX: cx + Math.cos(midRad) * r * 0.62,
      innerY: cy + Math.sin(midRad) * r * 0.62,
      // 外侧百分比：落在饼图外侧
      outerX: cx + Math.cos(midRad) * (r + 14),
      outerY: cy + Math.sin(midRad) * (r + 14),
      anchor: (Math.cos(midRad) >= -0.05 ? 'start' : 'end') as 'start' | 'end',
      hasLen: sweep > 1
    };
    return seg;
  });

  return (
    <section className="panel fill-panel donut-panel" aria-label="频带占比">
      <div className="panel-header">
        <h2>频带占比</h2>
        <span className="panel-meta">中位参考 · IQR 伪迹抑制</span>
      </div>
      <div className="donut-body">
        <svg viewBox={`0 0 ${size} ${size}`} className="band-donut" role="img" aria-label="频带能量占比饼图">
          <circle cx={cx} cy={cy} r={r} fill="var(--chart-grid)" opacity={0.4} />
          {hasEnergy &&
            segments.map((seg) => (
              <g key={seg.key}>
                <path
                  d={seg.path}
                  fill={seg.color}
                  stroke="var(--surface-strong)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                />
                {seg.hasLen && (
                  <text
                    className="donut-symbol"
                    x={seg.innerX}
                    y={seg.innerY}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {seg.symbol}
                  </text>
                )}
                {seg.hasLen && (
                  <text
                    className="donut-percent"
                    x={seg.outerX}
                    y={seg.outerY}
                    textAnchor={seg.anchor}
                    dominantBaseline="central"
                  >
                    {formatBandSharePercent(seg.label, seg.percent)}
                  </text>
                )}
              </g>
            ))}
          {!hasEnergy && (
            <>
              <text className="donut-core-label" x={cx} y={cy - 6} textAnchor="middle" dominantBaseline="central">
                —
              </text>
              <text className="donut-core-sub" x={cx} y={cy + 12} textAnchor="middle" dominantBaseline="central">
                等待信号
              </text>
            </>
          )}
        </svg>
      </div>
    </section>
  );
}
