import { describe, expect, test } from 'vitest';
import {
  resolveEegShareListColumns,
  resolveNormalGridColumns,
  resolveSettingsFormColumns,
  resolveSettingsPanelWidth,
  resolveViewportDensity
} from './layout';

describe('dashboard layout helpers', () => {
  test('uses compact density for short monitoring windows', () => {
    expect(resolveViewportDensity(920)).toBe('comfortable');
    expect(resolveViewportDensity(820)).toBe('compact');
    expect(resolveViewportDensity(720)).toBe('micro');
  });

  test('keeps normal waveforms in enough columns to fit one screen', () => {
    expect(resolveNormalGridColumns(1920, true)).toBe(5);
    expect(resolveNormalGridColumns(1320, true)).toBe(4);
    expect(resolveNormalGridColumns(1440, true)).toBe(4);
    expect(resolveNormalGridColumns(1120, true)).toBe(3);
    expect(resolveNormalGridColumns(900, false)).toBe(3);
    expect(resolveNormalGridColumns(700, false)).toBe(2);
  });

  test('matches settings panel width to CSS breakpoints', () => {
    expect(resolveSettingsPanelWidth(1680)).toBe(380);
    expect(resolveSettingsPanelWidth(1181)).toBe(360);
    expect(resolveSettingsPanelWidth(1180)).toBe(320);
    expect(resolveSettingsPanelWidth(821)).toBe(320);
    expect(resolveSettingsPanelWidth(820)).toBe(280);
  });

  test('uses a single settings form column when the settings rail is narrow', () => {
    expect(resolveSettingsFormColumns(360)).toBe(2);
    expect(resolveSettingsFormColumns(320)).toBe(1);
    expect(resolveSettingsFormColumns(280)).toBe(1);
  });

  test('uses a compact two-column band share legend when the eeg side panel has room', () => {
    expect(resolveEegShareListColumns(1280, true)).toBe(2);
    expect(resolveEegShareListColumns(1180, true)).toBe(2);
    expect(resolveEegShareListColumns(900, true)).toBe(1);
    expect(resolveEegShareListColumns(900, false)).toBe(2);
  });
});
