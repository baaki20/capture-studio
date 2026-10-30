/**
 * Pure helpers for the Linux packaging smoke test (scripts/smoke-linux-package.ts): what the
 * packages must contain, and parsers for .desktop files, asar headers and `electron-fuses read`.
 */
import { promises as fs } from 'node:fs';

/** Fuse states the packaged binary must have (spec §1.3, electron-builder.yml). */
export const EXPECTED_FUSES: Readonly<Record<string, boolean>> = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  OnlyLoadAppFromAsar: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  EnableCookieEncryption: true,
};

/** Files under `resources/` that every Linux package ships (§1.10, §8 Q1). */
export const REQUIRED_RESOURCES = [
  'app.asar',
  'LICENSE.txt',
  'licenses/FFMPEG-NOTICE.txt',
  'licenses/FFMPEG-SOURCE-OFFER.txt',
  'bin/linux-x64/LICENSE.txt',
  'bin/linux-x64/BUILD-INFO.json',
] as const;
export const REQUIRED_EXECUTABLES = ['bin/linux-x64/ffmpeg', 'bin/linux-x64/ffprobe'] as const;

/** `[Desktop Entry]` keys and values that must be present (exactly) in the installed entry. */
export function expectedDesktopEntry(appId: string): Readonly<Record<string, string>> {
  return {
    Type: 'Application',
    Name: 'Capture Studio',
    Icon: 'capture-studio',
    Categories: 'AudioVideo;Video;Recorder;',
    StartupWMClass: appId,
    Terminal: 'false',
  };
}

/** Parses the `[Desktop Entry]` group of a .desktop file (other groups are ignored). */
export function parseDesktopEntry(text: string): Record<string, string> {
  const entry: Record<string, string> = {};
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq > 0) entry[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return entry;
}

/** Problems with a desktop entry, as messages; empty when it is fine. */
export function checkDesktopEntry(entry: Record<string, string>, appId: string): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expectedDesktopEntry(appId))) {
    if (entry[key] !== value) {
      problems.push(
        `${key} is ${JSON.stringify(entry[key] ?? null)}, expected ${JSON.stringify(value)}`,
      );
    }
  }
  const exec = entry.Exec ?? '';
  if (!exec.endsWith(' %U')) problems.push(`Exec ${JSON.stringify(exec)} does not end with %U`);
  return problems;
}

/** Parses `electron-fuses read` output ("  RunAsNode is Disabled") into a name → enabled map. */
export function parseFuseReport(text: string): Record<string, boolean> {
  const fuses: Record<string, boolean> = {};
  for (const match of text.matchAll(/^\s*(\w+) is (Enabled|Disabled)\s*$/gm)) {
    const [, name, state] = match;
    if (name && name !== 'undefined') fuses[name] = state === 'Enabled';
  }
  return fuses;
}

export function checkFuses(actual: Record<string, boolean>): string[] {
  return Object.entries(EXPECTED_FUSES)
    .filter(([name, enabled]) => actual[name] !== enabled)
    .map(
      ([name, enabled]) =>
        `${name} is ${actual[name] === undefined ? 'missing' : actual[name] ? 'Enabled' : 'Disabled'}, expected ${enabled ? 'Enabled' : 'Disabled'}`,
    );
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

export interface AsarArchive {
  /** Every file path in the archive, `/`-separated, without a leading slash. */
  files: string[];
  /** Reads one (packed) file's bytes. */
  read(file: string): Promise<Buffer>;
}

/**
 * Reads an asar archive's header: a Chromium pickle holding the header size, then a pickle
 * holding the JSON string. File data starts right after the header.
 */
export async function openAsar(archivePath: string): Promise<AsarArchive> {
  const handle = await fs.open(archivePath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    await handle.read(json, 0, jsonLength, 16);
    const root = JSON.parse(json.toString('utf8')) as AsarNode;
    const dataStart = 8 + headerSize;

    const index = new Map<string, AsarNode>();
    const walk = (node: AsarNode, prefixPath: string): void => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const full = prefixPath ? `${prefixPath}/${name}` : name;
        if (child.files) walk(child, full);
        else index.set(full, child);
      }
    };
    walk(root, '');

    return {
      files: [...index.keys()].sort(),
      async read(file) {
        const node = index.get(file);
        if (node?.offset === undefined || node.size === undefined || node.unpacked) {
          throw new Error(`${file} is not a packed file in ${archivePath}`);
        }
        const data = Buffer.alloc(node.size);
        const reader = await fs.open(archivePath, 'r');
        try {
          await reader.read(data, 0, node.size, dataStart + Number(node.offset));
        } finally {
          await reader.close();
        }
        return data;
      },
    };
  } finally {
    await handle.close();
  }
}

/** Files that must never ship inside app.asar: sources, tests, source maps, dev configs. */
export function unexpectedAsarFiles(files: readonly string[]): string[] {
  return files.filter(
    (f) =>
      f.endsWith('.map') ||
      /^(src|tests|scripts|spikes|docs|resources|build|dist|\.cache)\//.test(f) ||
      /^[^/]*\.config\.(ts|js)$/.test(f) ||
      f.startsWith('node_modules/electron/') ||
      f.startsWith('node_modules/electron-builder/'),
  );
}
