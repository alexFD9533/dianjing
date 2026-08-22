import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyExtensionEntry } from './entry-policy';

const manifest = JSON.parse(
  fs.readFileSync(path.resolve('apps/dock-extension/public/manifest.json'), 'utf8'),
) as { permissions: string[]; host_permissions?: string[]; optional_host_permissions?: string[] };

describe('classifyExtensionEntry', () => {
  it('routes blank pages to the sessionless workspace', () => {
    expect(classifyExtensionEntry('about:blank', false)).toMatchObject({
      kind: 'workspace',
      entry: 'blank',
    });
  });

  it('routes file pages without file access to the permission guide', () => {
    expect(classifyExtensionEntry('file:///D:/demo.html', false)).toMatchObject({
      kind: 'workspace',
      entry: 'file-access',
    });
    expect(classifyExtensionEntry('file:///D:/demo.html', true)).toEqual({
      kind: 'inject',
      mode: 'local-page',
    });
  });

  it('allows ordinary web pages as a web copy without broad host access', () => {
    expect(classifyExtensionEntry('https://example.com/product', false)).toEqual({
      kind: 'inject',
      mode: 'web-copy',
    });
    expect(classifyExtensionEntry('http://localhost:5173/', false)).toEqual({
      kind: 'inject',
      mode: 'local-page',
    });
  });

  it('keeps browser pages and extension stores restricted', () => {
    expect(classifyExtensionEntry('chrome://settings/', true)).toMatchObject({
      kind: 'workspace',
      entry: 'restricted',
    });
    expect(
      classifyExtensionEntry('https://chromewebstore.google.com/detail/example', true),
    ).toMatchObject({ kind: 'workspace', entry: 'restricted' });
  });

  it('does not request downloads or mandatory broad host permissions', () => {
    expect(manifest.permissions).not.toContain('downloads');
    expect('host_permissions' in manifest).toBe(false);
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });
});
