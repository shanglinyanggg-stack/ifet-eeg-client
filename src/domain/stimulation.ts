export interface StimulusConfig {
  modality: 'sound' | 'light'; lightBrightness: number; lightFullscreen: boolean; lightMonitor: string;
  source: 'wav' | 'test-tone'; wavPath: string; audioDevice: string; serialPort: string;
  serialEnabled: boolean; serialOnOffset: boolean; durationSeconds: number; cueSeconds: number;
  restSeconds: number; trials: number; blocks: number; pauseBetweenBlocks: boolean; volume: number;
  participantId: string;
}
export interface StimulusStatus {
  active: boolean; phase: string; message: string; runId: string; block: number; trial: number;
  markerCount: number; logPath: string; markerPath: string; audioDevice: string;
  totalBlocks: number; totalTrials: number;
  audioSampleRate: number; stimulusSeconds: number; lastDispatchLatenessMs: number | null;
  lastAudioLeadMs: number | null; lastSerialWriteMs: number | null;
}
export interface StimulusEvent {
  timestamp: string; label: string; note: string; sampleCount: number; markerPath: string;
}
export const defaultStimulusConfig: StimulusConfig = {
  modality: 'sound', lightBrightness: 0.25, lightFullscreen: false, lightMonitor: '',
  source: 'wav', wavPath: '', audioDevice: '', serialPort: '', serialEnabled: false,
  serialOnOffset: true, durationSeconds: 5, cueSeconds: 1, restSeconds: 2, trials: 5,
  blocks: 3, pauseBetweenBlocks: true, volume: 0.1, participantId: ''
};
export const initialStimulusStatus: StimulusStatus = {
  active: false, phase: 'idle', message: '导入原始刺激 WAV，然后开始 EEG 记录', runId: '', block: 0,
  trial: 0, totalBlocks: 0, totalTrials: 0, markerCount: 0, logPath: '', markerPath: '', audioDevice: '', audioSampleRate: 0,
  stimulusSeconds: 0, lastDispatchLatenessMs: null, lastAudioLeadMs: null, lastSerialWriteMs: null
};
export const stimulusPhaseLabels: Record<string, string> = {
  benchmark: '静音时序自测',
  idle: '待机', preparing: '准备 / 串口握手', cue: '刺激提示', playing: '刺激中', rest: '刺激间隔',
  'waiting-block': '等待下一组', complete: '实验完成', aborted: '已中止', error: '异常停止'
};
export function stimulusStartReason(config: StimulusConfig, context: { connected: boolean; recording: boolean; acquisitionMode: boolean; demoMode: boolean }): string | null {
  if (context.demoMode) return '演示数据不能用于刺激实验';
  if (!context.acquisitionMode) return '请先进入实验采集模式，停用助眠音乐与自动控制';
  if (!context.connected) return '请先连接头带并确认 EEG 正常';
  if (!context.recording) return '请先开始 EEG 数据记录';
  if (config.modality === 'sound' && config.source === 'wav' && !config.wavPath) return '请导入原刺激 WAV；测试音不等同于 Don chirp';
  if (config.serialEnabled && !config.serialPort) return '请选择 Arduino 串口';
  return null;
}
