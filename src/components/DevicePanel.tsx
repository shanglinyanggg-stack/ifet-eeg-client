import { Bluetooth, CircleStop, Link2Off, Radio, RefreshCcw, Save, Send } from 'lucide-react';
import type { DeviceInfo } from '../domain/protocol';
import { ThemedSelect } from './ThemedSelect';

interface DevicePanelProps {
  devices: DeviceInfo[];
  connected: boolean;
  scanning: boolean;
  recording: boolean;
  recordingPending?: boolean;
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
  recordingPending = false,
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
  const deviceOptions = [
    { value: '', label: '选择设备' },
    ...devices.map((device) => ({
      value: device.id,
      label: `${device.name} / ${device.rssi} dBm`
    }))
  ];
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
  const connectedDeviceName = selectedDevice?.name || selectedDeviceId || '当前设备';
  const connectedDeviceDetail = selectedDevice
    ? `${selectedDevice.id} · ${status}`
    : status;

  const stateValue = connected ? 'connected' : scanning ? 'scanning' : 'disconnected';

  return (
    <section className="device-strip" aria-label="设备控制">
      <div className="status-block" data-state={stateValue}>
        <div className={`status-dot ${connected ? 'online' : ''} ${scanning ? 'scanning' : ''}`} />
        <div>
          <strong>{connected ? `已连接：${connectedDeviceName}` : scanning ? '扫描中' : '未连接'}</strong>
          <span title={connected ? connectedDeviceDetail : status}>
            {connected ? connectedDeviceDetail : status}
          </span>
        </div>
      </div>
      <div className="device-group">
        <button className="icon-button" type="button" onClick={onScan} disabled={scanning} title="扫描 BLE">
          {scanning ? <RefreshCcw size={18} className="spin" /> : <Bluetooth size={18} />}
          <span>{scanning ? '扫描中' : '扫描'}</span>
        </button>
        <ThemedSelect
          className="device-select"
          ariaLabel="选择设备"
          value={selectedDeviceId}
          options={deviceOptions}
          onChange={onSelectedDeviceChange}
        />
      </div>
      <div className="device-group">
        <button className="icon-button primary" type="button" onClick={onConnect} disabled={!selectedDeviceId || connected}>
          <Radio size={18} />
          <span>连接</span>
        </button>
        <button className="icon-button" type="button" onClick={onDisconnect} disabled={!connected}>
          <Link2Off size={18} />
          <span>断开</span>
        </button>
      </div>
      <div className="device-group">
        <input
          className="command-input"
          value={commandText}
          onChange={(event) => onCommandTextChange(event.target.value)}
          aria-label="十六进制命令"
          placeholder="AA 55 01 01"
        />
        <button className="icon-button" type="button" onClick={onSend} disabled={!connected}>
          <Send size={18} />
          <span>发送</span>
        </button>
      </div>
      <div className="device-group">
        <button
          className={`icon-button ${recording ? 'danger recording-active' : 'primary'}`}
          type="button"
          onClick={onToggleRecording}
          disabled={recordingPending}
        >
          {recording ? <CircleStop size={18} /> : <Save size={18} />}
          <span>{recordingPending ? '处理中' : recording ? '停止' : '记录'}</span>
        </button>
        {recordPath && <span className="record-path" title={recordPath}>{recordPath}</span>}
      </div>
    </section>
  );
}
