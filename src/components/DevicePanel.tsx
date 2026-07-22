import {
  BatteryCharging,
  BatteryMedium,
  Bluetooth,
  CircleStop,
  Clock3,
  Gauge,
  Link2Off,
  Radio,
  RefreshCcw,
  Save
} from 'lucide-react';
import { bleSampleRateOptions, type BatteryEvent, type DeviceInfo } from '../domain/protocol';
import type { BleSampleRate } from '../domain/settings';
import { formatRecordingDuration } from '../domain/recording-time';
import { ThemedSelect } from './ThemedSelect';

interface DevicePanelProps {
  devices: DeviceInfo[];
  connected: boolean;
  scanning: boolean;
  recording: boolean;
  recordingPending?: boolean;
  recordingElapsedSeconds?: number;
  selectedDeviceId: string;
  selectedSampleRateHz: BleSampleRate;
  activeSampleRateHz: BleSampleRate;
  sampleRatePending?: boolean;
  batteryStatus?: BatteryEvent | null;
  status: string;
  recordPath: string;
  onSelectedDeviceChange: (value: string) => void;
  onScan: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSelectedSampleRateChange: (value: BleSampleRate) => void;
  onApplySampleRate: () => void;
  onToggleRecording: () => void;
}

export function DevicePanel({
  devices,
  connected,
  scanning,
  recording,
  recordingPending = false,
  recordingElapsedSeconds = 0,
  selectedDeviceId,
  selectedSampleRateHz,
  activeSampleRateHz,
  sampleRatePending = false,
  batteryStatus = null,
  status,
  recordPath,
  onSelectedDeviceChange,
  onScan,
  onConnect,
  onDisconnect,
  onSelectedSampleRateChange,
  onApplySampleRate,
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
        <button
          className={`icon-button ${scanning ? 'danger' : ''}`}
          type="button"
          onClick={onScan}
          title={scanning ? '停止持续扫描' : '持续扫描并连接 BLE'}
        >
          {scanning ? <RefreshCcw size={18} className="spin" /> : <Bluetooth size={18} />}
          <span>{scanning ? '停止扫描' : '扫描'}</span>
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
        <button className="icon-button primary" type="button" onClick={onConnect} disabled={!selectedDeviceId || connected || scanning}>
          <Radio size={18} />
          <span>连接</span>
        </button>
        <button className="icon-button" type="button" onClick={onDisconnect} disabled={!connected}>
          <Link2Off size={18} />
          <span>断开</span>
        </button>
      </div>
      <div
        className="device-group battery-group"
        aria-label="设备电量"
        title={batteryStatus
          ? `原始计量值 ${batteryStatus.rawValue} · 序号 ${batteryStatus.sequence}`
          : connected ? '等待设备发送 0x03/0x04 电压帧' : '连接设备后显示电量'}
      >
        {batteryStatus?.charging
          ? <BatteryCharging size={20} aria-hidden="true" />
          : <BatteryMedium size={20} aria-hidden="true" />}
        <div className="battery-copy">
          <span>设备电量</span>
          <strong>{batteryStatus ? `${batteryStatus.voltage.toFixed(2)} V` : '--'}</strong>
          <small>{batteryStatus
            ? batteryStatus.charging ? '正在充电' : '正常使用'
            : connected ? '等待上报' : '未连接'}</small>
        </div>
      </div>
      <div className="device-group">
        <ThemedSelect
          className="sample-rate-select"
          ariaLabel="BLE 采样率"
          value={String(selectedSampleRateHz)}
          options={bleSampleRateOptions}
          onChange={(value) => onSelectedSampleRateChange(Number(value) as BleSampleRate)}
        />
        <button
          className="icon-button"
          type="button"
          onClick={onApplySampleRate}
          disabled={!connected || sampleRatePending}
          title={`向 FFF5 写入采样率命令，当前 ${activeSampleRateHz === 1000 ? '1 kHz' : `${activeSampleRateHz} Hz`}`}
        >
          <Gauge size={18} />
          <span>{sampleRatePending ? '设置中' : '设置采样率'}</span>
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
        {recording && (
          <span className="recording-time" aria-label="数据记录时长">
            <Clock3 size={15} aria-hidden="true" />
            记录时长 <strong>{formatRecordingDuration(recordingElapsedSeconds)}</strong>
          </span>
        )}
        {recordPath && <span className="record-path" title={recordPath}>{recordPath}</span>}
      </div>
    </section>
  );
}
