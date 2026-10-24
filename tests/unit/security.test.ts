import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCsp } from '../../src/shared/security/csp';

vi.mock('electron', () => ({ app: { isPackaged: true, on: vi.fn() }, session: {}, shell: {} }));
const { isAppUrl, isSafeExternalUrl, secureWebPreferences } =
  await import('../../src/main/security/web-security');

const ROOT = path.join(import.meta.dirname, '../..');

describe('security baseline (§1.3)', () => {
  it('every window is sandboxed with context isolation and no Node', () => {
    expect(secureWebPreferences('/p/shell.cjs')).toMatchObject({
      preload: '/p/shell.cjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    });
  });

  it('opens only https: and mailto: links externally', () => {
    expect(isSafeExternalUrl('https://example.org/x')).toBe(true);
    expect(isSafeExternalUrl('mailto:someone@example.org')).toBe(true);
    for (const url of [
      'http://example.org',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'smb://host/share',
      'nonsense',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it('recognises app URLs in development and production', () => {
    const dev = { devServerUrl: 'http://localhost:5173', rendererDir: '/app/out/renderer' };
    expect(isAppUrl('http://localhost:5173/shell/index.html', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('https://evil.example/', dev)).toBe(false);

    const prod = { rendererDir: '/opt/Capture Studio/resources/app.asar/out/renderer' };
    expect(
      isAppUrl(
        'file:///opt/Capture%20Studio/resources/app.asar/out/renderer/shell/index.html',
        prod,
      ),
    ).toBe(true);
    expect(
      isAppUrl('file:///opt/Capture%20Studio/resources/app.asar/out/renderer-evil/x.html', prod),
    ).toBe(false);
    expect(isAppUrl('file:///etc/passwd', prod)).toBe(false);
  });

  it('production CSP allows only self-hosted code', () => {
    const csp = buildCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/https?:/);
    expect(csp).toContain("object-src 'none'");
  });

  it('dev CSP adds only the dev server', () => {
    const csp = buildCsp({ devServerOrigin: 'http://localhost:5173' });
    expect(csp).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173");
  });

  it('lets pages show project thumbnails from cs-media: and nothing else remote', () => {
    const imgSrc = /img-src ([^;]*)/.exec(buildCsp())?.[1]?.split(' ');
    expect(imgSrc).toEqual(["'self'", 'data:', 'blob:', 'cs-media:']);
    expect(buildCsp()).not.toMatch(/(script|connect|frame)-src[^;]*cs-media/);
  });

  it('electron-builder flips the required fuses', () => {
    const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    for (const line of [
      'runAsNode: false',
      'enableNodeOptionsEnvironmentVariable: false',
      'onlyLoadAppFromAsar: true',
      'enableEmbeddedAsarIntegrityValidation: true',
      'enableCookieEncryption: true',
    ]) {
      expect(yml).toContain(line);
    }
  });

  it('package metadata: GPL-3.0-or-later, exact Electron pin, Node 24', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      license: string;
      devDependencies: Record<string, string>;
      engines: { node: string };
    };
    expect(pkg.license).toBe('GPL-3.0-or-later');
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.engines.node).toBe('>=24');
    expect(readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()).toBe('24.22.1');
  });
});
