import { themeOptions, type AppSettings, type EegBandKey, type EegChannel, type ThemeName } from '../domain/settings';
import { createEegBands } from '../domain/dsp';
import { channelLabels, type ChannelKey } from '../domain/protocol';

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

const channels = Object.keys(channelLabels) as ChannelKey[];

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const update = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });
  const updateEeg = (patch: Partial<AppSettings['eeg']>) =>
    onChange({ ...settings, eeg: { ...settings.eeg, ...patch } });

  return (
    <aside className="settings-panel" aria-label="后台设置">
      <div className="panel-header">
        <h2>后台设置</h2>
      </div>
      <label>
        显示模式
        <select value={settings.displayMode} onChange={(event) => update({ displayMode: event.target.value as AppSettings['displayMode'] })}>
          <option value="normal">全部波形</option>
          <option value="eeg">脑电模式</option>
        </select>
      </label>
      <label>
        界面主题
        <select value={settings.theme} onChange={(event) => update({ theme: event.target.value as ThemeName })}>
          {themeOptions.map((theme) => (
            <option key={theme.value} value={theme.value}>
              {theme.label}
            </option>
          ))}
        </select>
      </label>
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
        <input value={settings.recordDir} onChange={(event) => update({ recordDir: event.target.value })} />
      </label>

      <div className="setting-group">
        <h3>原始滤波</h3>
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
        <h3>脑电参数</h3>
        <label>
          EEG 通道
          <select value={settings.eeg.selectedChannel} onChange={(event) => updateEeg({ selectedChannel: event.target.value as EegChannel })}>
            <option value="eeg1">EEG1</option>
            <option value="eeg2">EEG2</option>
            <option value="eeg3">EEG3</option>
            <option value="eeg4">EEG4</option>
          </select>
        </label>
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
        <label>
          陷波
          <select value={settings.eeg.notch} onChange={(event) => updateEeg({ notch: parseNotch(event.target.value) })}>
            <option value="off">关闭</option>
            <option value="50">50 Hz</option>
            <option value="60">60 Hz</option>
          </select>
        </label>
        <div className="band-editor">
          {createEegBands().map((band) => (
            <div className="band-row" key={band.key}>
              <span style={{ color: band.color }}>{band.label}</span>
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
        <h3>通道显示</h3>
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
