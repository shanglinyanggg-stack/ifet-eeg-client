import type { BandValue } from './dsp';

export interface BandAmplitudeInput extends BandValue {
  lowHz: number;
  highHz: number;
}

/**
 * Compensate the expected 1/f aperiodic amplitude slope while the wearer is
 * awake or staging is still warming up. Direct absolute-amplitude comparison
 * is biased toward low frequencies even without an oscillation. The confirmed
 * eyes-open recordings use an aperiodic power exponent of 1.5, so amplitude is
 * compensated by center-frequency^0.75. Sleep-stage bands remain unmodified so
 * NREM Delta/Theta can rise naturally.
 */
export function compensateAwakeAperiodicSlope(
  bands: BandAmplitudeInput[],
  realtimeStage: string
): BandValue[] {
  if (!isAwakeLike(realtimeStage)) {
    return bands.map(({ label, value }) => ({ label, value }));
  }
  const alpha = bands.find((band) => band.label === 'Alpha');
  const referenceHz = alpha ? centerFrequency(alpha.lowHz, alpha.highHz) : 10.5;
  return bands.map((band) => ({
    label: band.label,
    value: band.value * Math.pow(centerFrequency(band.lowHz, band.highHz) / referenceHz, 0.75)
  }));
}

function centerFrequency(lowHz: number, highHz: number): number {
  return Math.max(0.1, (Math.max(0, lowHz) + Math.max(lowHz, highHz)) / 2);
}

function isAwakeLike(stage: string): boolean {
  const normalized = stage.trim().toUpperCase();
  if (normalized === 'W' || normalized.startsWith('W ') || normalized.includes('清醒')) return true;
  return normalized.length === 0
    || normalized.includes('预热')
    || normalized.includes('等待')
    || normalized.includes('连接中')
    || normalized.includes('本地降级');
}
