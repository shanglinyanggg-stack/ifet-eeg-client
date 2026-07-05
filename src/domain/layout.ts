export type ViewportDensity = 'comfortable' | 'compact' | 'micro';

const ULTRA_WIDE_SETTINGS_PANEL_WIDTH = 380;
const WIDE_SETTINGS_PANEL_WIDTH = 360;
const MEDIUM_SETTINGS_PANEL_WIDTH = 320;
const NARROW_SETTINGS_PANEL_WIDTH = 280;
const WORKSPACE_GAP = 12;

export function resolveViewportDensity(height: number): ViewportDensity {
  if (height < 760) return 'micro';
  if (height < 900) return 'compact';
  return 'comfortable';
}

export function resolveNormalGridColumns(width: number, settingsOpen: boolean): number {
  const availableWidth = settingsOpen ? width - resolveSettingsPanelWidth(width) - WORKSPACE_GAP : width;
  if (availableWidth >= 1320) return 5;
  if (availableWidth >= 920) return 4;
  if (availableWidth >= 720) return 3;
  return 2;
}

export function resolveSettingsPanelWidth(width: number): number {
  if (width >= 1600) return ULTRA_WIDE_SETTINGS_PANEL_WIDTH;
  if (width > 1180) return WIDE_SETTINGS_PANEL_WIDTH;
  if (width > 820) return MEDIUM_SETTINGS_PANEL_WIDTH;
  return NARROW_SETTINGS_PANEL_WIDTH;
}

export function resolveSettingsFormColumns(settingsPanelWidth: number): 1 | 2 {
  return settingsPanelWidth >= WIDE_SETTINGS_PANEL_WIDTH ? 2 : 1;
}

export function resolveEegShareListColumns(width: number, settingsOpen: boolean): 1 | 2 {
  const availableWidth = settingsOpen ? width - resolveSettingsPanelWidth(width) - WORKSPACE_GAP : width;
  const sidePanelWidth = availableWidth * 0.46;
  return sidePanelWidth >= 360 ? 2 : 1;
}
