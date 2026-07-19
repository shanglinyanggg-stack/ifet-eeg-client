import type { SampleEvent } from './protocol';

// 与 EEG 采样率保持一致：保证 α/β/γ 频带在 Nyquist 内不混叠，滤波输出有意义
export const DEMO_SAMPLE_RATE = 100;

// 累计样本序号，用作相位基准，避免依赖 Date.now 抖动
let phase = 0;

const TAU = Math.PI * 2;

function noise(amp: number): number {
  return (Math.random() - 0.5) * amp;
}

// 合成多通道样本：EEG 叠加 δ/θ/α/β 正弦并让幅度缓慢呼吸，PPG 为脉搏波，ACC 近静止
function buildPacket(t: number) {
  const deltaAmp = 18;
  const thetaAmp = 10;
  // α/β 幅度缓慢起伏，使频带占比饼图随时间动态变化
  const alphaAmp = 26 + 14 * Math.sin(TAU * 0.07 * t);
  const betaAmp = 12 + 8 * Math.sin(TAU * 0.13 * t + 1);

  const eegValue = (ph: number) =>
    deltaAmp * Math.sin(TAU * 2 * t + ph) +
    thetaAmp * Math.sin(TAU * 6 * t + ph) +
    alphaAmp * Math.sin(TAU * 10 * t + ph) +
    betaAmp * Math.sin(TAU * 20 * t + ph) +
    noise(8);

  const pulse = 1.2; // ~72bpm
  const ppgValue = (base: number, amp: number, ph: number) =>
    base + amp * Math.sin(TAU * pulse * t + ph) + noise(1.5);

  const accValue = (ph: number) => 0.05 * Math.sin(TAU * 0.3 * t + ph) + noise(0.02);

  return {
    ppg: {
      ir1: ppgValue(400, 30, 0),
      red1: ppgValue(300, 24, 0.15),
      green1: ppgValue(200, 14, 0.3),
      ir2: ppgValue(410, 28, 0.6),
      red2: ppgValue(305, 22, 0.75),
      green2: ppgValue(205, 13, 0.9),
      accX: accValue(0),
      accY: accValue(1.2),
      accZ: accValue(2.4)
    },
    eeg: {
      eeg1: eegValue(0),
      eeg2: eegValue(0.7),
      eeg3: eegValue(1.4),
      eeg4: eegValue(2.1)
    }
  };
}

// 生成 count 个连续样本（10ms 间隔），最后一个对齐当前时刻
export function createDemoSamples(count: number): SampleEvent[] {
  const now = Date.now();
  const startIdx = phase;
  phase += count;
  const events: SampleEvent[] = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const t = idx / DEMO_SAMPLE_RATE;
    const timestamp = new Date(now - (count - 1 - i) * (1000 / DEMO_SAMPLE_RATE)).toISOString();
    events.push({ timestamp, packet: buildPacket(t) });
  }
  return events;
}
