import { describe, expect, test, beforeEach } from 'vitest';
import { defaultSettings, loadSettings, saveSettings, themeOptions } from './settings';

describe('settings persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('uses EEG auto defaults', () => {
    expect(defaultSettings.displayMode).toBe('normal');
    expect(defaultSettings.theme).toBe('neuro-dark');
    expect(defaultSettings.eeg.selectedChannel).toBe('eeg1');
    expect(defaultSettings.eeg.scale).toBe('auto');
    expect(defaultSettings.eeg.timeWindowSeconds).toBe('auto');
    expect(defaultSettings.eeg.bandpassEnabled).toBe(false);
  });

  test('offers four dashboard themes', () => {
    expect(themeOptions.map((theme) => theme.value)).toEqual([
      'neuro-dark',
      'clinical-light',
      'graphite',
      'amber-lab'
    ]);
  });

  test('round-trips settings through localStorage', () => {
    saveSettings({
      ...defaultSettings,
      displayMode: 'eeg',
      theme: 'clinical-light',
      autoReconnect: true,
      eeg: {
        ...defaultSettings.eeg,
        selectedChannel: 'eeg3',
        scale: 120,
        timeWindowSeconds: 8
      }
    });

    const loaded = loadSettings();

    expect(loaded.displayMode).toBe('eeg');
    expect(loaded.theme).toBe('clinical-light');
    expect(loaded.autoReconnect).toBe(true);
    expect(loaded.eeg.selectedChannel).toBe('eeg3');
    expect(loaded.eeg.scale).toBe(120);
    expect(loaded.eeg.timeWindowSeconds).toBe(8);
  });
});
