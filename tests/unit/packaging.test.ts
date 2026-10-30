import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resolveFfmpegPaths } from '../../src/main/ffmpeg/locate';
import {
  ICON_CANVAS,
  ICON_SIZES,
  iconSvg,
  rasterizeIcon,
  renderIconPng,
} from '../../scripts/icon-art';
import {
  checkDesktopEntry,
  checkFuses,
  EXPECTED_FUSES,
  openAsar,
  parseDesktopEntry,
  parseFuseReport,
  unexpectedAsarFiles,
} from '../../scripts/package-checks';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function text(file: string): Promise<string> {
  return fs.readFile(path.join(ROOT, file), 'utf8');
}

/** One top-level `key: value` line of electron-builder.yml. */
function yamlScalar(yaml: string, key: string): string | undefined {
  return new RegExp(`^${key}: (.+)$`, 'm').exec(yaml)?.[1]?.trim();
}

describe('app icon', () => {
  it('build/ holds the generated icon set (run `npm run gen:icons` after changing it)', async () => {
    expect(await text('build/icon.svg')).toBe(iconSvg());
    expect(
      (await fs.readFile(path.join(ROOT, 'build/icon.png'))).equals(renderIconPng(ICON_CANVAS)),
    ).toBe(true);
    for (const size of ICON_SIZES) {
      const file = path.join(ROOT, 'build/icons', `${String(size)}x${String(size)}.png`);
      expect((await fs.readFile(file)).equals(renderIconPng(size)), file).toBe(true);
    }
  });

  it('encodes valid RGBA PNGs of the requested size', () => {
    const png = renderIconPng(16);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    expect(png[25]).toBe(6); // colour type RGBA
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe((16 * 4 + 1) * 16);
  });

  it('has transparent corners, an opaque tile and the red record dot in the middle', () => {
    const size = 64;
    const px = rasterizeIcon(size);
    const at = (x: number, y: number): number[] => [
      ...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
    ];
    expect(at(0, 0)[3]).toBe(0);
    expect(at(size - 1, size - 1)[3]).toBe(0);
    expect(at(8, size / 2)[3]).toBe(255);
    const [r, g, b, a] = at(size / 2, Math.round((236 / ICON_CANVAS) * size));
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(120);
    expect(b).toBeLessThan(120);
  });
});

describe('packaging configuration', () => {
  it('uses desktopName as the app id, matching appId, with the .desktop name synced to it', async () => {
    const pkg = JSON.parse(await text('package.json')) as Record<string, unknown>;
    const yaml = await text('electron-builder.yml');
    expect(pkg.desktopName).toBe(`${String(yamlScalar(yaml, 'appId'))}.desktop`);
    expect(yaml).toMatch(/^ {2}syncDesktopName: true$/m);
    expect(yaml).toMatch(/^ {2}category: AudioVideo;Video;Recorder;$/m);
    expect(yaml).toMatch(/^ {2}icon: build\/icons$/m);
    expect(yamlScalar(yaml, 'executableName')).toBe('capture-studio');
    expect(pkg.license).toBe('GPL-3.0-or-later');
    expect(pkg.homepage).toMatch(/^https:\/\//);
  });

  it('flips every fuse the smoke test expects', async () => {
    const yaml = await text('electron-builder.yml');
    const block = /^electronFuses:\n((?: {2}.+\n)+)/m.exec(yaml)?.[1] ?? '';
    const configured = Object.fromEntries(
      [...block.matchAll(/^ {2}(\w+): (true|false)$/gm)].map((m) => [
        (m[1] ?? '').replace(/^./, (c) => c.toUpperCase()),
        m[2] === 'true',
      ]),
    );
    expect(configured).toEqual(EXPECTED_FUSES);
  });

  it('ships FFmpeg where the packaged locate() looks for it', async () => {
    const yaml = await text('electron-builder.yml');
    expect(yaml).toContain(
      'from: resources/bin/${platform}-${arch}\n    to: bin/${platform}-${arch}',
    );
    const loc = resolveFfmpegPaths({
      isPackaged: true,
      resourcesPath: '/opt/Capture Studio/resources',
      appPath: '/opt/Capture Studio/resources/app.asar',
      platform: 'linux',
      arch: 'x64',
      env: { CS_FFMPEG_DIR: '/elsewhere' },
    });
    expect(loc.ffmpeg).toBe('/opt/Capture Studio/resources/bin/linux-x64/ffmpeg');
  });
});

describe('package checks', () => {
  it('parses and checks a desktop entry', () => {
    const entry = parseDesktopEntry(
      [
        '[Desktop Entry]',
        'Name=Capture Studio',
        'Exec="/opt/Capture Studio/capture-studio" %U',
        'Terminal=false',
        'Type=Application',
        'Icon=capture-studio',
        'StartupWMClass=org.example.App',
        'Categories=AudioVideo;Video;Recorder;',
        '',
        '[Desktop Action New]',
        'Name=Other',
      ].join('\n'),
    );
    expect(entry.Name).toBe('Capture Studio');
    expect(checkDesktopEntry(entry, 'org.example.App')).toEqual([]);
    expect(checkDesktopEntry({ ...entry, Exec: 'capture-studio' }, 'org.example.App')).toEqual([
      'Exec "capture-studio" does not end with %U',
    ]);
    expect(checkDesktopEntry(entry, 'other')[0]).toContain('StartupWMClass');
  });

  it('parses electron-fuses output', () => {
    const report = parseFuseReport(
      [
        'Fuse Version: v1',
        '  RunAsNode is Disabled',
        '  EnableCookieEncryption is Enabled',
        '  EnableNodeOptionsEnvironmentVariable is Disabled',
        '  EnableNodeCliInspectArguments is Disabled',
        '  EnableEmbeddedAsarIntegrityValidation is Enabled',
        '  OnlyLoadAppFromAsar is Enabled',
        '  undefined is Enabled',
      ].join('\n'),
    );
    expect(checkFuses(report)).toEqual([]);
    expect(checkFuses({ ...report, RunAsNode: true })).toEqual([
      'RunAsNode is Enabled, expected Disabled',
    ]);
  });

  it('reads an asar archive and flags files that must not ship', async () => {
    const files = { 'package.json': '{"name":"x"}', 'out/main/index.js': 'main' };
    const header = {
      files: {
        'package.json': { size: files['package.json'].length, offset: '0' },
        out: {
          files: {
            main: {
              files: {
                'index.js': {
                  size: files['out/main/index.js'].length,
                  offset: String(files['package.json'].length),
                },
              },
            },
          },
        },
      },
    };
    const json = Buffer.from(JSON.stringify(header));
    const padded = Math.ceil(json.length / 4) * 4;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(padded + 8, 4);
    prefix.writeUInt32LE(padded + 4, 8);
    prefix.writeUInt32LE(json.length, 12);
    const archive = Buffer.concat([
      prefix,
      json,
      Buffer.alloc(padded - json.length),
      Buffer.from(files['package.json'] + files['out/main/index.js']),
    ]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-asar-'));
    try {
      const file = path.join(dir, 'app.asar');
      await fs.writeFile(file, archive);
      const asar = await openAsar(file);
      expect(asar.files).toEqual(['out/main/index.js', 'package.json']);
      expect((await asar.read('out/main/index.js')).toString()).toBe('main');
      expect((await asar.read('package.json')).toString()).toBe('{"name":"x"}');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(
      unexpectedAsarFiles([
        'out/main/index.js',
        'out/main/index.js.map',
        'src/main/index.ts',
        'package.json',
      ]),
    ).toEqual(['out/main/index.js.map', 'src/main/index.ts']);
  });
});
