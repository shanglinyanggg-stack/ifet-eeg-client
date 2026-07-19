import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('production html shell', () => {
  test('does not ship preview-only Tauri mocks or locked settings', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(html).not.toContain('__TAURI_INTERNALS__');
    expect(html).not.toContain('Storage.prototype.setItem');
    expect(html).not.toContain('__startSampleFeed');
    expect(html).not.toContain('预览模式桩');
  });
});
