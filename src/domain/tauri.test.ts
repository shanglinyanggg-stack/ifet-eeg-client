import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('tauri windows entrypoint', () => {
  test('uses the Windows GUI subsystem in release builds', () => {
    const mainRs = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');

    expect(mainRs).toContain('windows_subsystem = "windows"');
  });
});
