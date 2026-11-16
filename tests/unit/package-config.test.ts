/**
 * electron-builder.yml (P3 step 9): what each target ships. Text checks on its top-level
 * sections (no YAML dependency), guarding the mistakes that are easy to make and costly to find
 * only in an installer: `${platform}` in a path means the build machine, so one target's FFmpeg
 * would ship in another's package.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(path.join(import.meta.dirname, '../../electron-builder.yml'), 'utf8');

/** Top-level sections: `name:` at column 0 up to the next one. */
function sections(): Map<string, string> {
  const out = new Map<string, string>();
  let name = '';
  for (const line of text.split('\n')) {
    const head = /^([A-Za-z][\w]*):/.exec(line);
    if (head?.[1]) name = head[1];
    if (name) out.set(name, `${out.get(name) ?? ''}${line}\n`);
  }
  return out;
}

describe('electron-builder.yml', () => {
  const s = sections();

  it('ships each target its own FFmpeg and native helper', () => {
    for (const [section, os] of [
      ['win', 'win32'],
      ['mac', 'darwin'],
      ['linux', 'linux'],
    ] as const) {
      const body = s.get(section) ?? '';
      expect(body, section).toContain(`from: resources/bin/${os}-\${arch}`);
      expect(body, section).toContain(`to: bin/${os}-\${arch}`);
      expect(body, section).toContain(`from: resources/native/${os}-\${arch}`);
    }
    expect(text).not.toMatch(/from: [^\n]*\$\{platform\}/);
  });

  it('associates packs everywhere and the project folder on macOS (plan D9)', () => {
    expect(s.get('fileAssociations')).toContain('ext: cstudiopack');
    const mac = s.get('mac') ?? '';
    expect(mac).toMatch(
      /ext: cstudio\n\s+name: Capture Studio project\n\s+role: Editor\n\s+isPackage: true/,
    );
  });

  it('declares why macOS may use the camera and microphone', () => {
    const mac = s.get('mac') ?? '';
    expect(mac).toContain('NSCameraUsageDescription:');
    expect(mac).toContain('NSMicrophoneUsageDescription:');
    expect(mac).toContain('hardenedRuntime: true');
  });

  it('updates from the project’s GitHub Releases (plan D4)', () => {
    const publish = s.get('publish') ?? '';
    expect(publish).toContain('provider: github');
    expect(publish).toContain('owner: baaki20');
    expect(publish).toContain('repo: capture-studio');
  });
});

describe('package scripts', () => {
  it('never publish (electron-builder would on CI, where the publish config needs a token)', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const name of ['package:linux', 'package:win', 'package:mac']) {
      expect(pkg.scripts[name], name).toMatch(/electron-builder [^&]*--publish never/);
    }
  });
});
