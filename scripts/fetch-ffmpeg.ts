/**
 * Downloads the pinned FFmpeg + ffprobe builds into resources/bin/<platform>-<arch>/ (spec §1.10).
 *
 * Usage:
 *   npm run fetch:ffmpeg                       # the current platform
 *   npm run fetch:ffmpeg -- --platform linux-x64
 *   npm run fetch:ffmpeg -- --all
 *   npm run fetch:ffmpeg -- --record           # fill in missing per-file hashes in the manifest
 *
 * The archive's SHA-256 must match the manifest before anything is extracted, and every
 * extracted file must match its own pinned SHA-256. Archives are cached in .cache/ffmpeg/.
 * Extraction uses the system `tar` (GNU tar on Linux, bsdtar on macOS and Windows 10+).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'scripts', 'ffmpeg-manifest.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'ffmpeg');
const BIN_DIR = path.join(ROOT, 'resources', 'bin');

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const ManifestSchema = z.object({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  builds: z.record(
    z.string().regex(/^(linux|win32|darwin)-(x64|arm64)$/),
    z.object({
      provider: z.string(),
      release: z.string(),
      version: z.string(),
      variant: z.string(),
      license: z.string(),
      archive: z.object({
        fileName: z.string().regex(/^[\w.+-]+$/),
        format: z.enum(['tar.xz', 'zip']),
        urls: z.array(z.url({ protocol: /^https$/ })).min(1),
        sha256: Sha256,
        /** Top-level folder inside the archive. */
        root: z.string(),
      }),
      files: z.record(
        z.string().regex(/^[\w.-]+$/),
        z.object({ from: z.string(), sha256: Sha256.nullable(), executable: z.boolean() }),
      ),
      source: z.record(z.string(), z.string()),
    }),
  ),
});

type Manifest = z.infer<typeof ManifestSchema>;
type Build = Manifest['builds'][string];

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function log(message: string): void {
  process.stdout.write(`[fetch-ffmpeg] ${message}\n`);
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${String(response.status)} ${response.statusText} (${url})`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0 && process.stdout.isTTY && Date.now() - lastReport > 500) {
      lastReport = Date.now();
      process.stdout.write(`\r[fetch-ffmpeg]   ${((received / total) * 100).toFixed(0)}%`);
    }
  });
  const partial = `${target}.part`;
  await pipeline(body, createWriteStream(partial));
  if (process.stdout.isTTY && total > 0) process.stdout.write('\n');
  await fs.rename(partial, target);
}

/** Returns a cached or freshly downloaded archive whose SHA-256 matches the pin. */
async function obtainArchive(build: Build): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const archivePath = path.join(CACHE_DIR, build.archive.fileName);
  if ((await exists(archivePath)) && (await sha256File(archivePath)) === build.archive.sha256) {
    log(`using cached ${build.archive.fileName}`);
    return archivePath;
  }
  await fs.rm(archivePath, { force: true });

  const errors: string[] = [];
  for (const url of build.archive.urls) {
    try {
      log(`downloading ${url}`);
      await download(url, archivePath);
      const actual = await sha256File(archivePath);
      if (actual !== build.archive.sha256) {
        await fs.rm(archivePath, { force: true });
        throw new Error(`SHA-256 mismatch: expected ${build.archive.sha256}, got ${actual}`);
      }
      log('archive SHA-256 verified');
      return archivePath;
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not obtain ${build.archive.fileName}:\n  ${errors.join('\n  ')}`);
}

/** True when every pinned file is present with the pinned hash. */
async function isInstalled(build: Build, dir: string): Promise<boolean> {
  for (const [name, file] of Object.entries(build.files)) {
    const target = path.join(dir, name);
    if (!file.sha256 || !(await exists(target)) || (await sha256File(target)) !== file.sha256) {
      return false;
    }
  }
  return true;
}

async function installBuild(
  key: string,
  build: Build,
  options: { record: boolean; force: boolean },
): Promise<boolean> {
  const targetDir = path.join(BIN_DIR, key);
  if (!options.force && (await isInstalled(build, targetDir))) {
    log(`${key}: up to date (${build.version})`);
    return false;
  }

  const archivePath = await obtainArchive(build);
  // Extract into a fresh, empty directory that is only ever read from, never executed in.
  const extractDir = await fs.mkdtemp(path.join(CACHE_DIR, `extract-${key}-`));
  try {
    log(`${key}: extracting`);
    const tar = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error(`tar failed with exit code ${String(tar.status)}`);

    const stagingDir = `${targetDir}.staging`;
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    let recorded = false;
    for (const [name, file] of Object.entries(build.files)) {
      const source = path.join(extractDir, build.archive.root, file.from);
      const resolved = path.resolve(source);
      if (!resolved.startsWith(path.resolve(extractDir) + path.sep)) {
        throw new Error(`refusing path outside the archive: ${file.from}`);
      }
      if (!(await fs.lstat(resolved)).isFile()) {
        throw new Error(`${file.from} in the archive is not a regular file`);
      }
      const target = path.join(stagingDir, name);
      await fs.copyFile(resolved, target);
      await fs.chmod(target, file.executable ? 0o755 : 0o644);
      const actual = await sha256File(target);
      if (file.sha256 === null) {
        if (!options.record) {
          throw new Error(
            `${key}/${name} has no pinned SHA-256; run with --record after verifying the archive`,
          );
        }
        file.sha256 = actual;
        recorded = true;
        log(`${key}/${name}: recorded SHA-256 ${actual}`);
      } else if (actual !== file.sha256) {
        throw new Error(`${key}/${name}: SHA-256 mismatch: expected ${file.sha256}, got ${actual}`);
      }
    }

    await fs.writeFile(
      path.join(stagingDir, 'BUILD-INFO.json'),
      JSON.stringify({ key, ...build, archive: { ...build.archive } }, null, 2) + '\n',
    );
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(stagingDir, targetDir);
    log(`${key}: installed ${build.version} into ${path.relative(ROOT, targetDir)}`);
    return recorded;
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', multiple: true },
      all: { type: 'boolean', default: false },
      record: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  const manifest = ManifestSchema.parse(JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')));
  const keys = values.all
    ? Object.keys(manifest.builds)
    : (values.platform ?? [`${process.platform}-${process.arch}`]);

  let manifestChanged = false;
  for (const key of keys) {
    const build = manifest.builds[key];
    if (!build)
      throw new Error(`no pinned FFmpeg build for ${key} in scripts/ffmpeg-manifest.json`);
    manifestChanged =
      (await installBuild(key, build, { record: values.record, force: values.force })) ||
      manifestChanged;
  }

  if (manifestChanged) {
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    log('updated scripts/ffmpeg-manifest.json with recorded hashes');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[fetch-ffmpeg] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
