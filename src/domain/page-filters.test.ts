import {describe,test,expect} from 'vitest';
import {defaultSettings} from './settings';
import {normalizePageFilters,settingsForSignalPage} from './page-filters';
describe('independent display-only page filters',()=>{
  test('migrates legacy settings into separate copies',()=>{
    const filters=normalizePageFilters(undefined,{...defaultSettings,eeg:{...defaultSettings.eeg,bandpassEnabled:true,bandpassLow:1,bandpassHigh:35}});
    expect(filters.eeg.enabled).toBe(true);expect(filters.sleep.low).toBe(1);expect(filters.eeg).not.toBe(filters.sleep);
  });
  test('page projection never changes transport, recording, LSL or algorithm settings',()=>{
    const settings={...defaultSettings,pageFilters:{...defaultSettings.pageFilters,eeg:{...defaultSettings.pageFilters.eeg,enabled:true,low:8,high:13}}};
    const projected=settingsForSignalPage(settings,'eeg');
    expect(projected.eeg.bandpassLow).toBe(8);expect(projected.eeg.bandpassEnabled).toBe(true);
    expect(projected.bleSampleRateHz).toBe(settings.bleSampleRateHz);expect(projected.lsl).toBe(settings.lsl);
    expect(projected.sleepMusic).toBe(settings.sleepMusic);expect(projected.recordDir).toBe(settings.recordDir);
    expect(settingsForSignalPage(settings,'sleep').eeg.bandpassEnabled).toBe(false);
  });
});
