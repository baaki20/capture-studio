/**
 * Builds the native helper (`native/cs-native`, plan D7) for this machine and copies it to
 * resources/native/<platform>-<arch>/cs-native.node, where main loads it in development and
 * electron-builder picks it up for packages.
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

async function main(): Promise<void> {
  const build = spawnSync(
    cargo(),
    ['build', '--release', '--locked', '--manifest-path', path.join(CRATE, 'Cargo.toml')],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) throw new Error(`cargo build failed (${String(build.status)})`);
  const from = path.join(CRATE, 'target', 'release', libraryName());
  const dir = path.join(ROOT, 'resources', 'native', `${process.platform}-${process.arch}`);
  await fs.mkdir(dir, { recursive: true });
  const to = path.join(dir, 'cs-native.node');
  await fs.copyFile(from, to);
  console.log(`[build-native] ${path.relative(ROOT, to)}`);
}

main().catch((error: unknown) => {
  console.error(`[build-native] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
