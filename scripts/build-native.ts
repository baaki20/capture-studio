/**
 * Builds the native helper (`native/cs-native`, plan D7) for this machine and copies it to
 * resources/native/<platform>-<arch>/cs-native.node, where main loads it in development and
 * electron-builder picks it up for packages. Next to it goes NOTICES.txt: every crate built for
 * this platform with its licence texts (from the crate sources; crates that ship none get their
 * declared licence and repository), so the notices travel with the helper.
 *
 * Usage:
 *   npm run build:native
 *
 * Needs a Rust toolchain (rustup); `cargo` is looked up on PATH, then in ~/.cargo/bin.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(ROOT, 'native', 'cs-native');

function cargo(): string {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const home = path.join(os.homedir(), '.cargo', 'bin', exe);
  const onPath = spawnSync(exe, ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return exe;
  if (existsSync(home)) return home;
  throw new Error('cargo was not found: install Rust with rustup (https://rustup.rs)');
}

/** The cdylib cargo writes for this platform. */
function libraryName(): string {
  if (process.platform === 'win32') return 'cs_native.dll';
  if (process.platform === 'darwin') return 'libcs_native.dylib';
  return 'libcs_native.so';
}

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  repository: string | null;
  manifest_path: string;
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

function rustHost(cargoPath: string): string {
  const rustc = path.join(
    path.dirname(cargoPath),
    process.platform === 'win32' ? 'rustc.exe' : 'rustc',
  );
  const out = spawnSync(path.isAbsolute(cargoPath) ? rustc : 'rustc', ['-vV'], {
    encoding: 'utf8',
  });
  const host = /^host: (.+)$/m.exec(out.stdout)?.[1];
  if (!host) throw new Error('rustc -vV did not name the host');
  return host.trim();
}

/** The third-party notices of the crates built for this platform. */
async function notices(cargoPath: string): Promise<string> {
  const out = spawnSync(
    cargoPath,
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--filter-platform',
      rustHost(cargoPath),
      '--manifest-path',
      path.join(CRATE, 'Cargo.toml'),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.status !== 0) throw new Error(`cargo metadata failed: ${out.stderr}`);
  const meta = JSON.parse(out.stdout) as {
    packages: CargoPackage[];
    resolve: { nodes: { id: string }[] };
  };
  const used = new Set(meta.resolve.nodes.map((n) => n.id));
  const packages = meta.packages
    .filter((p) => p.name !== 'cs-native' && used.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const parts = [
    'Third-party software in the Capture Studio native helper (cs-native)',
    '',
    ...packages.map((p) => `- ${p.name} ${p.version} (${p.license ?? 'licence not declared'})`),
  ];
  for (const p of packages) {
    const dir = path.dirname(p.manifest_path);
    const files = (await fs.readdir(dir))
      .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
      .sort();
    parts.push('', '='.repeat(78), `${p.name} ${p.version} — ${p.license ?? ''}`, '='.repeat(78));
    if (files.length === 0) {
      parts.push(
        `No licence file ships with this crate. Its declared licence is ${p.license ?? 'unknown'}; see ${p.repository ?? 'crates.io'} for the copyright holders.`,
      );
      if (p.license?.includes('MIT')) parts.push('', MIT_TEXT);
      continue;
    }
    for (const file of files) {
      parts.push(
        '',
        `--- ${file} ---`,
        '',
        (await fs.readFile(path.join(dir, file), 'utf8')).trim(),
      );
    }
  }
  return `${parts.join('\n')}\n`;
}

async function main(): Promise<void> {
  const cargoPath = cargo();
  const build = spawnSync(
    cargoPath,
    ['build', '--release', '--locked', '--manifest-path', path.join(CRATE, 'Cargo.toml')],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) throw new Error(`cargo build failed (${String(build.status)})`);
  const from = path.join(CRATE, 'target', 'release', libraryName());
  const dir = path.join(ROOT, 'resources', 'native', `${process.platform}-${process.arch}`);
  await fs.mkdir(dir, { recursive: true });
  const to = path.join(dir, 'cs-native.node');
  await fs.copyFile(from, to);
  await fs.writeFile(path.join(dir, 'NOTICES.txt'), await notices(cargoPath));
  console.log(`[build-native] ${path.relative(ROOT, to)} and NOTICES.txt`);
}

main().catch((error: unknown) => {
  console.error(`[build-native] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
