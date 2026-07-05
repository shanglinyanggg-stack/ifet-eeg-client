import type React from 'react';
import { themeOptions, type AppSettings, type EegBandKey, type EegChannel, type ThemeName } from '../domain/settings';
import { createEegBands } from '../domain/dsp';
import { channelLabels, type ChannelKey } from '../domain/protocol';
import { ThemedSelect } from './ThemedSelect';
import { FolderOpen } from 'lucide-react';

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

const channels = Object.keys(channelLabels) as ChannelKey[];
const displayModeOptions = [
  { value: 'normal', label: '全部波形' },
  { value: 'eeg', label: '脑电模式' }
];
const eegChannelOptions = [
  { value: 'eeg1', label: 'EEG1' },
  { value: 'eeg2', label: 'EEG2' },
  { value: 'eeg3', label: 'EEG3' },
  { value: 'eeg4', label: 'EEG4' }
];
const notchOptions = [
  { value: 'off', label: '关闭' },
  { value: '50', label: '50 Hz' },
  { value: '60', label: '60 Hz' }
];

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const update = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });
  const updateEeg = (patch: Partial<AppSettings['eeg']>) =>
    onChange({ ...settings, eeg: { ...settings.eeg, ...patch } });

  return (
    <aside className="settings-panel" aria-label="后台设置">
      <div className="panel-header">
        <h2>后台设置</h2>
      </div>
      <div className="field-control">
        <span className="field-label">显示模式</span>
        <ThemedSelect
          ariaLabel="显示模式"
          value={settings.displayMode}
          options={displayModeOptions}
          onChange={(displayMode) => update({ displayMode: displayMode as AppSettings['displayMode'] })}
        />
      </div>
      <div className="field-control">
        <span className="field-label">界面主题</span>
        <ThemedSelect
          ariaLabel="界面主题"
          value={settings.theme}
          options={themeOptions}
          onChange={(theme) => update({ theme: theme as ThemeName })}
        />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.autoReconnect} onChange={(event) => update({ autoReconnect: event.target.checked })} />
        自动重连
      </label>
      <label className="check-row">
        <input type="checkbox" checked={settings.showChartsOnly} onChange={(event) => update({ showChartsOnly: event.target.checked })} />
        纯波形模式
      </label>
      <label>
        预热秒数
        <input
          type="number"
          min={0}
          value={settings.warmupDelaySeconds}
          onChange={(event) => update({ warmupDelaySeconds: Number(event.target.value) })}
        />
      </label>
      <label>
        保存目录
        <div className="dir-row">
          <input value={settings.recordDir} onChange={(event) => update({ recordDir: event.target.value })} placeholder="留空使用默认目录" />
          <button
            type="button"
            className="icon-button"
            onClick={async () => {
              const picked = await pickDirectory();
              if (picked) update({ recordDir: picked });
            }}
            title="选择目录"
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </label>

      <div className="setting-group">
        <h3><span className="group-dot" />原始滤波</h3>
        <label className="check-row">
          <input type="checkbox" checked={settings.filterEnabled} onChange={(event) => update({ filterEnabled: event.target.checked })} />
          带通滤波
        </label>
        <div className="two-col">
          <label>
            低频 Hz
            <input type="number" step="0.1" value={settings.filterLow} onChange={(event) => update({ filterLow: Number(event.target.value) })} />
          </label>
          <label>
            高频 Hz
            <input type="number" step="0.1" value={settings.filterHigh} onChange={(event) => update({ filterHigh: Number(event.target.value) })} />
          </label>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={settings.kalmanEnabled} onChange={(event) => update({ kalmanEnabled: event.target.checked })} />
          卡尔曼滤波
        </label>
        <div className="two-col">
          <label>
            Q
            <input type="number" step="0.01" value={settings.kalmanQ} onChange={(event) => update({ kalmanQ: Number(event.target.value) })} />
          </label>
          <label>
            R
            <input type="number" step="0.1" value={settings.kalmanR} onChange={(event) => update({ kalmanR: Number(event.target.value) })} />
          </label>
        </div>
      </div>

      <div className="setting-group">
        <h3><span className="group-dot" />脑电参数</h3>
        <div className="field-control">
          <span className="field-label">EEG 通道</span>
          <ThemedSelect
            ariaLabel="EEG 通道"
            value={settings.eeg.selectedChannel}
            options={eegChannelOptions}
            onChange={(selectedChannel) => updateEeg({ selectedChannel: selectedChannel as EegChannel })}
          />
        </div>
        <div className="two-col">
          <label>
            Scale
            <input value={settings.eeg.scale} onChange={(event) => updateEeg({ scale: parseAutoNumber(event.target.value) })} />
          </label>
          <label>
            时间窗 s
            <input value={settings.eeg.timeWindowSeconds} onChange={(event) => updateEeg({ timeWindowSeconds: parseAutoNumber(event.target.value) })} />
          </label>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={settings.eeg.bandpassEnabled} onChange={(event) => updateEeg({ bandpassEnabled: event.target.checked })} />
          EEG 带通
        </label>
        <div className="two-col">
          <label>
            EEG 低频
            <input type="number" step="0.1" value={settings.eeg.bandpassLow} onChange={(event) => updateEeg({ bandpassLow: Number(event.target.value) })} />
          </label>
          <label>
            EEG 高频
            <input type="number" step="0.1" value={settings.eeg.bandpassHigh} onChange={(event) => updateEeg({ bandpassHigh: Number(event.target.value) })} />
          </label>
        </div>
        <div className="field-control">
          <span className="field-label">陷波</span>
          <ThemedSelect
            ariaLabel="陷波"
            value={String(settings.eeg.notch)}
            options={notchOptions}
            onChange={(notch) => updateEeg({ notch: parseNotch(notch) })}
          />
        </div>
        <div className="band-editor">
          {createEegBands().map((band) => (
            <div className="band-row" key={band.key} style={{ '--band-color': band.color } as React.CSSProperties}>
              <span>{band.label}</span>
              <input
                type="number"
                step="0.1"
                value={settings.eeg.bandRanges[band.key].low}
                onChange={(event) => updateBand(settings, onChange, band.key, 'low', Number(event.target.value))}
              />
              <input
                type="number"
                step="0.1"
                value={settings.eeg.bandRanges[band.key].high}
                onChange={(event) => updateBand(settings, onChange, band.key, 'high', Number(event.target.value))}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="setting-group">
        <h3><span className="group-dot" />通道显示</h3>
        <div className="channel-grid">
          {channels.map((channel) => (
            <label className="check-row" key={channel}>
              <input
                type="checkbox"
                checked={settings.visibleChannels[channel] ?? true}
                onChange={(event) =>
                  update({
                    visibleChannels: {
                      ...settings.visibleChannels,
                      [channel]: event.target.checked
                    }
                  })
                }
              />
              {channelLabels[channel]}
            </label>
          ))}
        </div>
      </div>
    </aside>
  );
}

function parseAutoNumber(value: string) {
  if (value.trim().toLowerCase() === 'auto') return 'auto';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'auto';
}

async function pickDirectory(): Promise<string | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false });
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

function parseNotch(value: string): AppSettings['eeg']['notch'] {
  if (value === '50') return 50;
  if (value === '60') return 60;
  return 'off';
}

function updateBand(
  settings: AppSettings,
  onChange: (settings: AppSettings) => void,
  band: EegBandKey,
  side: 'low' | 'high',
  value: number
) {
  onChange({
    ...settings,
    eeg: {
      ...settings.eeg,
      bandRanges: {
        ...settings.eeg.bandRanges,
        [band]: {
          ...settings.eeg.bandRanges[band],
          [side]: value
        }
      }
    }
  });
}
