import type { BandShare } from '../domain/dsp';

interface BandShareChartProps {
  shares: BandShare[];
  colors: Record<string, string>;
}

export function BandShareChart({ shares, colors }: BandShareChartProps) {
  let start = 0;
  const segments = shares.map((share) => {
    const angle = (share.percent / 100) * 360;
    const segment = `${colors[share.label] ?? '#64748b'} ${start}deg ${start + angle}deg`;
    start += angle;
    return segment;
  });
  const background = segments.length > 0 ? `conic-gradient(${segments.join(', ')})` : '#1e293b';

  return (
    <section className="panel share-panel" aria-label="脑电频带占比">
      <div className="panel-header">
        <h2>频带占比</h2>
      </div>
      <div className="donut" style={{ background }}>
        <div className="donut-core">EEG</div>
      </div>
      <div className="share-list">
        {shares.map((share) => (
          <div className="share-row" key={share.label}>
            <span className="legend-dot" style={{ backgroundColor: colors[share.label] }} />
            <span>{share.label}</span>
            <strong>{share.percent}%</strong>
            <span className="share-meter" aria-hidden="true">
              <span style={{ width: `${share.percent}%`, backgroundColor: colors[share.label] }} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
