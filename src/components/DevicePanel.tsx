import { Bluetooth, CircleStop, Link2Off, Radio, RefreshCcw, Save, Send } from 'lucide-react';
import type { DeviceInfo } from '../domain/protocol';

interface DevicePanelProps {
  devices: DeviceInfo[];
  connected: boolean;
  scanning: boolean;
  recording: boolean;
  selectedDeviceId: string;
  commandText: string;
  status: string;
  recordPath: string;
  onCommandTextChange: (value: string) => void;
  onSelectedDeviceChange: (value: string) => void;
  onScan: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSend: () => void;
  onToggleRecording: () => void;
}

export function DevicePanel({
  devices,
  connected,
  scanning,
  recording,
  selectedDeviceId,
  commandText,
  status,
  recordPath,
  onCommandTextChange,
  onSelectedDeviceChange,
  onScan,
  onConnect,
  onDisconnect,
  onSend,
  onToggleRecording
}: DevicePanelProps) {
  return (
    <section className="device-strip" aria-label="设备控制">
      <div className="status-block">
        <div className={`status-dot ${connected ? 'online' : ''}`} />
        <div>
          <strong>{connected ? '已连接' : '未连接'}</strong>
          <span>{status}</span>
        </div>
      </div>
      <button className="icon-button" type="button" onClick={onScan} disabled={scanning} title="扫描 BLE">
        {scanning ? <RefreshCcw size={18} /> : <Bluetooth size={18} />}
        <span>{scanning ? '扫描中' : '扫描'}</span>
      </button>
      <select value={selectedDeviceId} onChange={(event) => onSelectedDeviceChange(event.target.value)}>
        <option value="">选择设备</option>
        {devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name} / {device.rssi} dBm
          </option>
        ))}
      </select>
      <button className="icon-button" type="button" onClick={onConnect} disabled={!selectedDeviceId || connected}>
        <Radio size={18} />
        <span>连接</span>
      </button>
      <button className="icon-button" type="button" onClick={onDisconnect} disabled={!connected}>
        <Link2Off size={18} />
        <span>断开</span>
      </button>
      <input
        className="command-input"
        value={commandText}
        onChange={(event) => onCommandTextChange(event.target.value)}
        aria-label="十六进制命令"
      />
      <button className="icon-button" type="button" onClick={onSend} disabled={!connected}>
        <Send size={18} />
        <span>发送</span>
      </button>
      <button className={recording ? 'icon-button danger' : 'icon-button'} type="button" onClick={onToggleRecording}>
        {recording ? <CircleStop size={18} /> : <Save size={18} />}
        <span>{recording ? '停止' : '记录'}</span>
      </button>
      {recordPath && <span className="record-path">{recordPath}</span>}
    </section>
  );
}
