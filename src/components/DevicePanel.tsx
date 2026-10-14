import {
  BatteryCharging,
  BatteryLow,
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
import {
  batteryDisplayVoltage,
  batteryEstimatedPercent,
  batteryLevel,
  batteryStateLabel
} from '../domain/battery';
import type { BleSampleRate } from '../domain/settings';
import { formatRecordingDuration } from '../domain/recording-time';
import { ThemedSelect } from './ThemedSelect';
import type {BleDiagnostics} from '../domain/ble-diagnostics';

interface DevicePanelProps {
  showRecordingAction?:boolean;
  diagnostics?:BleDiagnostics|null;
  devices: DeviceInfo[];
  connected: boolean;
  scanning: boolean;
  recording: boolean;
  recordingPending?: boolean;
  recordingElapsedSeconds?: number;
  batteryRecording?: boolean;
  batteryRecordingPending?: boolean;
  batteryRecordPath?: string;
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
  onToggleBatteryRecording?: () => void;
}

export function DevicePanel({
  showRecordingAction=true,
  diagnostics,
  devices,
  connected,
  scanning,
  recording,
  recordingPending = false,
  recordingElapsedSeconds = 0,
  batteryRecording = false,
  batteryRecordingPending = false,
  batteryRecordPath = '',
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
  onToggleRecording,
  onToggleBatteryRecording = () => undefined
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
  const displayedBatteryLevel = batteryStatus ? batteryLevel(batteryStatus) : 'normal';

  return (
    <section className="device-strip" aria-label="设备控制">
      {connected&&diagnostics&&<details className="ble-diagnostics"><summary>接收链路诊断</summary>
        {diagnostics.linkRequestStatus&&<p>{diagnostics.linkRequestStatus}</p>}
        {diagnostics.connectionIntervalMs!=null&&<p>系统上报实际连接周期 {diagnostics.connectionIntervalMs.toFixed(2)} ms · 外围延迟 {diagnostics.peripheralLatency??'—'} 个连接事件（不是毫秒）</p>}
        <p>{(diagnostics.windowSeconds??1).toFixed(1)}秒滑动窗 · 包内原始样本 {diagnostics.observedSampleRateHz.toFixed(1)} Hz · 时基样本 {diagnostics.logicalSampleRateHz.toFixed(1)} Hz · 通知 {diagnostics.notificationRateHz.toFixed(1)} 次/秒</p>
        {diagnostics.receivedSlotRateHz!=null&&<p>结构槽位 {diagnostics.receivedSlotRateHz.toFixed(1)} /秒 · 已解析且非四通道全零 {diagnostics.usableEegSampleRateHz?.toFixed(1)??'—'} /秒 · 四通道全零 {diagnostics.zeroAdcSlots??0} 槽位 · 相邻完全重复 {diagnostics.identicalAdjacentAdcSlots??0} 对 · 可疑零尾帧 {diagnostics.suspiciousNotifications??0}。重复值只提示，不自动删样；非零也不代表生理信号有效。</p>}
        {diagnostics.rtcRaw!=null&&<p>设备RTC原始计数 {diagnostics.rtcRaw}（单位未确认，不用于推算采样率）。</p>}
        {diagnostics.transmitIntervalMs===0?<p>TD新协议：仅发送72采样率命令，没有发送0x93。每包点数由有效载荷解析，不假定通知间隔。</p>:diagnostics.transmitIntervalMs!=null&&<p>打包请求 {diagnostics.transmitIntervalMs} ms（93 {diagnostics.transmitIntervalMs.toString(16).padStart(2,'0').toUpperCase()}） · 预计 {diagnostics.expectedSamplesPerNotification} 点/包 · {diagnostics.packingConfirmed?'当前帧长符合请求':'尚未从帧长确认'}；不是设备ACK或ADC时钟验证。</p>}
        <p>每包 {diagnostics.samplesPerNotification} 个原始样本 · 接收队列 {diagnostics.bufferedNotifications}/2048 · 处理等待 {diagnostics.processingDelayMs} ms（本秒峰值 {diagnostics.peakProcessingDelayMs} ms） · 无法解析 {diagnostics.rejectedNotifications} 包</p>
        <p>已停用旧协议的自动扩包。槽位数量不等于有效ADC样本数；在真机验证前不能声明采样率已达标。</p>
        {diagnostics.observedSampleRateHz<diagnostics.requestedSampleRateHz*.98&&<p>实收尚未达到设置值，问题未解决。记录只保存实收槽位，不软件补点；显示插值不能补回真实数据。请勿使用不完整数据推断频带或睡眠。</p>}
      </details>}
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
        data-level={displayedBatteryLevel}
        title={batteryStatus
          ? `原始计量值 ${batteryStatus.rawValue} · 原始电压 ${batteryStatus.voltage.toFixed(3)} V · 3.29 V=0% · 序号 ${batteryStatus.sequence}`
          : connected ? '等待设备发送 0x03/0x04 电压帧' : '连接设备后显示电量'}
      >
        {batteryStatus?.charging
          ? <BatteryCharging size={20} aria-hidden="true" />
          : displayedBatteryLevel === 'low' || displayedBatteryLevel === 'empty'
            ? <BatteryLow size={20} aria-hidden="true" />
            : <BatteryMedium size={20} aria-hidden="true" />}
        <div className="battery-copy">
          <span>设备电量</span>
          <strong>{batteryStatus
            ? `${batteryEstimatedPercent(batteryStatus)}% · ${batteryDisplayVoltage(batteryStatus).toFixed(2)} V`
            : '--'}</strong>
          <small>{batteryStatus
            ? batteryStateLabel(batteryStatus)
            : connected ? '等待上报' : '未连接'}</small>
        </div>
        <label
          className={`battery-record-switch ${batteryRecording ? 'is-active' : ''}`}
          title={batteryRecordPath || '独立保存设备上报的电压，不要求同时记录 EEG'}
        >
          <input
            type="checkbox"
            role="switch"
            aria-label="电压记录开关"
            checked={batteryRecording}
            disabled={batteryRecordingPending}
            onChange={onToggleBatteryRecording}
          />
          <span>{batteryRecordingPending ? '处理中' : batteryRecording ? '记录中' : '记录电压'}</span>
        </label>
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
      {showRecordingAction&&<div className="device-group">
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
      </div>}
    </section>
  );
}
