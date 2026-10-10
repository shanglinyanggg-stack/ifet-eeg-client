import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface BridgeStatus {
  running: boolean; connected: boolean; port: number; event_count: number;
  active_stimuli: number; last_event: string; last_receive_delay_ms: number | null;
  last_durable_delay_ms: number | null; clock_uncertainty_ms: number | null;
  event_path: string; csv_path: string; connection_path: string; last_error: string;
  alignment_pending: boolean; alignment_path: string;
}
const empty: BridgeStatus = { running: false, connected: false, port: 45321, event_count: 0,
  active_stimuli: 0, last_event: '', last_receive_delay_ms: null, last_durable_delay_ms: null,
  clock_uncertainty_ms: null, event_path: '', csv_path: '', connection_path: '', last_error: '',
  alignment_pending: false, alignment_path: '' };
const ms = (value: number | null) => value === null ? '—' : `${value.toFixed(2)} ms`;

export function MatlabBridgeSection({ onPrepare }: { onPrepare?: () => void }) {
  const [status, setStatus] = useState(empty);
  const [port, setPort] = useState(45321);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => invoke<BridgeStatus>('matlab_bridge_status').then(next => {
      if (!cancelled) setStatus(next);
    }).catch(() => undefined);
    void refresh(); const timer = window.setInterval(() => void refresh(), 500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const operate = async (command: string, args: Record<string, unknown>) => {
    setPending(true); setError('');
    if (command === 'matlab_bridge_start') onPrepare?.();
    try { setStatus(await invoke<BridgeStatus>(command, args)); }
    catch (e) { setError(String(e)); } finally { setPending(false); }
  };
  return <section className="matlab-bridge-section">
    <h3>MATLAB 刺激事件接收</h3>
    <p>上位机仅接收和标记；声光刺激、Arduino TTL 仍由 MATLAB 原程序负责。</p>
    <ol><li>连接头带，开始 EEG 数据记录。</li><li>点击下方“开始接收”，保持上位机运行。</li>
      <li>在 MATLAB 运行提供的带 Bridge 副本；原文件不会被覆盖。</li></ol>
    <label className="field-control">本机 TCP 端口
      <input aria-label="MATLAB 接收端口" type="number" min="1024" max="65535" value={port}
        disabled={status.running || pending} onChange={e => setPort(Number(e.target.value))} />
    </label>
    <div className="matlab-bridge-actions">
      <button disabled={pending || status.running} onClick={() => void operate('matlab_bridge_start', { port })}>开始接收</button>
      <button disabled={pending || !status.running} onClick={() => void operate('matlab_bridge_stop', { force: false })}>停止接收</button>
    </div>
    {status.running && status.active_stimuli > 0 && <button disabled={pending}
      onClick={() => { if (window.confirm('仅限 MATLAB 已异常退出。将保留未闭合刺激审计，不会伪造停止时间。是否强制停止？'))
        void operate('matlab_bridge_stop', { force: true }); }}>异常退出：强制停止接收</button>}
    <dl className="matlab-bridge-stats">
      <dt>状态</dt><dd>{status.running ? status.connected ? 'MATLAB 已连接 · 后台接收中' : '等待 MATLAB 连接' : '未接收'}</dd>
      <dt>已保存事件 / 进行中</dt><dd>{status.event_count} / {status.active_stimuli}</dd>
      <dt>最近动作</dt><dd>{status.last_event || '—'}</dd>
      <dt>刺激时间 → 收到消息</dt><dd>{ms(status.last_receive_delay_ms)}</dd>
      <dt>刺激时间 → 保存确认</dt><dd>{ms(status.last_durable_delay_ms)}</dd>
      <dt>时钟同步不确定度</dt><dd>±{ms(status.clock_uncertainty_ms)}</dd>
    </dl>
    <small>这里是软件时间估计，不是麦克风/光电传感器测得的物理延迟。每个开始、停止均单独保存时间和参数。</small>
    {status.connection_path && <p className="matlab-bridge-path">连接配置：{status.connection_path}</p>}
    {status.csv_path && <p className="matlab-bridge-path">参数表：{status.csv_path}</p>}
    {status.alignment_pending && <p>正在对齐已保存 EEG 的刺激位置…</p>}
    {status.alignment_path && <p className="matlab-bridge-path">最终 EEG 位置表：{status.alignment_path}</p>}
    {(error || status.last_error) && <p role="alert">{error || status.last_error}</p>}
    <p>最小化或切换 MATLAB 不会暂停接收。接收期间防止自动休眠和熄屏；不要退出、手动睡眠或合盖。</p>
  </section>;
}
