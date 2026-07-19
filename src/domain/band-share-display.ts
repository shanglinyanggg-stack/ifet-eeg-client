/** Delta is intentionally strongly attenuated while awake. Keep that small
 * residual visible without changing the integer presentation of other bands. */
export function formatBandSharePercent(label: string, percent: number): string {
  if (!Number.isFinite(percent)) return '--';
  const bounded = Math.max(0, Math.min(100, percent));
  if (label.toLowerCase() === 'delta') {
    if (bounded > 0 && bounded < 0.05) return '<0.1%';
    if (bounded > 0 && bounded < 1) return `${bounded.toFixed(1)}%`;
  }
  return `${Math.round(bounded)}%`;
}
