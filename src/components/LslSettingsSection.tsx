import { Radio, RefreshCw, Send } from 'lucide-react';
import type { LslStatus } from '../domain/lsl';
import type { AppSettings } from '../domain/settings';

interface LslSettingsSectionProps {
  settings: AppSettings;
  status: LslStatus;
  pending?: boolean;
  onChange: (settings: AppSettings) => void;
  onRefresh?: () => void;
  onTestMarker?: () => void;
}

export function LslSettingsSection({
  settings,
  status,
  pending = false,
  onChange,
  onRefresh,
  onTestMarker
}: LslSettingsSectionProps) {
  const update = (patch: Partial<AppSettings['lsl']>) => onChange({
    ...settings,
    lsl: { ...settings.lsl, ...patch }
  });
  const state = status.lastError ? 'error' : status.hasConsumers ? 'connected' : status.running ? 'waiting' : 'off';

  return (
    <div className="setting-group lsl-settings">
      <h3><span className="group-dot" /><Radio size={15} />Lab Streaming Layer</h3>
      <p className="setting-help lsl-intro">
        LSL 通过局域网向 LabRecorder、Python、MATLAB 等软件并行发布数据。它不会替代 BLE 或本地 CSV，也不会改变睡眠算法输入。
      </p>

      <label className="check-row lsl-enable-row">
        <input
          type="checkbox"
          checked={settings.lsl.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        启用 LSL 实时输出
      </label>

      <label>
        流名称前缀
        <input
          value={settings.lsl.streamName}
          maxLength={64}
          onChange={(event) => update({ streamName: event.target.value })}
          placeholder="iFET-TD10"
          aria-label="LSL 流名称前缀"
        />
      </label>
      <label>
        来源 ID
        <input
          value={settings.lsl.sourceId}
          maxLength={96}
          onChange={(event) => update({ sourceId: event.target.value })}
          placeholder="ifet-td10-headset"
          aria-label="LSL 来源 ID"
        />
        <small className="setting-help">同一局域网内每台头戴设备应使用唯一来源 ID。</small>
      </label>

      <div className="lsl-status-card" data-state={state} role="status">
        <div className="lsl-status-heading">
          <span><i />{pending ? '正在应用设置…' : status.message}</span>
          <button type="button" onClick={onRefresh} disabled={!onRefresh || pending} title="刷新 LSL 状态">
            <RefreshCw size={13} />刷新
          </button>
        </div>
        <dl>
          <div><dt>采样率</dt><dd>{status.sampleRateHz} Hz</dd></div>
          <div><dt>已发布样本</dt><dd>{status.samplesPublished.toLocaleString()}</dd></div>
          <div><dt>事件标记</dt><dd>{status.markersPublished.toLocaleString()}</dd></div>
          <div><dt>LSL 丢弃批次</dt><dd>{status.droppedBatches.toLocaleString()}</dd></div>
          <div><dt>协议 / 库</dt><dd>{status.protocolVersion} / {status.libraryVersion}</dd></div>
          <div><dt>接收端</dt><dd>{status.hasConsumers ? '已连接' : '未连接'}</dd></div>
        </dl>
        {status.lastError && <p className="lsl-error">{status.lastError}</p>}
      </div>

      {status.streams.length > 0 && (
        <div className="lsl-stream-list" aria-label="LSL 输出流">
          {status.streams.map((stream) => (
            <div key={stream.name}>
              <span><strong>{stream.name}</strong><small>{stream.streamType}</small></span>
              <em>{stream.channelCount} ch · {stream.nominalSampleRateHz > 0 ? `${stream.nominalSampleRateHz} Hz` : '事件'} · {stream.channelFormat}</em>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="lsl-test-button"
        onClick={onTestMarker}
        disabled={!onTestMarker || !status.running || pending}
      >
        <Send size={14} />发送 LSL 测试标记
      </button>

      <div className="lsl-notes">
        <strong>本版输出 4 条流</strong>
        <span>EEG：4 通道有符号 24 位原始 ADC 计数</span>
        <span>AUX：6 路 PPG + 3 轴运动</span>
        <span>Quality：有效位、设备序号、设备 Flag</span>
        <span>Markers：手动事件与对齐标记（JSON）</span>
      </div>
      <p className="setting-help">
        Windows 首次使用请允许“专用网络”防火墙访问。若跨电脑接收失败，请检查两台电脑在同一局域网且网络允许组播发现。
      </p>
    </div>
  );
}
