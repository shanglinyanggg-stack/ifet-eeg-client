import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('tauri windows entrypoint', () => {
  test('uses the Windows GUI subsystem in release builds', () => {
    const mainRs = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');

    expect(mainRs).toContain('windows_subsystem = "windows"');
  });

  test('allows local audio playback and file selection', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const capability = JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8'));

    expect(config.app.security.assetProtocol.enable).toBe(true);
    expect(config.app.security.csp).toContain('media-src');
    expect(config.bundle.resources).toContain('resources/SleepStagingAlgorithm_PC_v1.2.0/**/*');
    expect(existsSync(resolve(
      process.cwd(),
      'src-tauri/resources/SleepStagingAlgorithm_PC_v1.2.0/demo_signal_flags_contract.schema.json'
    ))).toBe(true);
    expect(existsSync(resolve(
      process.cwd(),
      'src-tauri/resources/SleepStagingAlgorithm_PC_v1.2.0/runtime/ifet-sleep-service.exe'
    ))).toBe(true);
    expect(capability.permissions).toContain('dialog:allow-open');
  });

  test('defines a native macOS BLE and packaging profile', () => {
    const config = JSON.parse(readFileSync(
      resolve(process.cwd(), 'src-tauri/tauri.macos.conf.json'),
      'utf8'
    ));
    const plist = readFileSync(resolve(process.cwd(), 'src-tauri/Info.plist'), 'utf8');

    expect(config.bundle.targets).toEqual(['app', 'dmg']);
    expect(config.bundle.category).toBe('HealthcareAndFitness');
    expect(config.bundle.icon).toContain('icons/icon.icns');
    expect(config.bundle.macOS.minimumSystemVersion).toBe('12.0');
    expect(config.bundle.resources[
      'target/macos-resources/SleepStagingAlgorithm_PC_v1.2.0/'
    ]).toBe('resources/SleepStagingAlgorithm_PC_v1.2.0/');
    expect(plist).toContain('NSBluetoothAlwaysUsageDescription');
    expect(plist).toContain('NSBluetoothPeripheralUsageDescription');
    expect(existsSync(resolve(process.cwd(), 'src-tauri/icons/icon.icns'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'scripts/build-macos.sh'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'scripts/stage_macos_algorithm.py'))).toBe(true);
  });
});
