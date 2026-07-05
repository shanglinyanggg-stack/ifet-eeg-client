import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('ui assets and chrome', () => {
  test('keeps the sticky settings header opaque to avoid blurred content shadows', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    const match = styles.match(/\.settings-panel \.panel-header\s*\{(?<body>[^}]*)\}/);

    expect(match?.groups?.body).toBeDefined();
    expect(match?.groups?.body).not.toContain('backdrop-filter');
    expect(match?.groups?.body).toContain('background: var(--surface-strong)');
  });

  test('ships a real Windows icon instead of the placeholder ico', () => {
    const iconPath = resolve(process.cwd(), 'src-tauri/icons/icon.ico');
    const icon = readFileSync(iconPath);
    const size = statSync(iconPath).size;
    const imageCount = icon.readUInt16LE(4);

    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    expect(imageCount).toBeGreaterThanOrEqual(4);
    expect(size).toBeGreaterThan(10000);
  });
});
