/**
 * Writes the app icon set from scripts/icon-art.ts: `build/icon.svg`, `build/icon.png` (512 px)
 * and `build/icons/<n>x<n>.png` for electron-builder's Linux targets (spec §4.5 step 20).
 * `npm run gen:icons`; a unit test fails when the committed files are out of date.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_CANVAS, ICON_SIZES, iconSvg, renderIconPng } from './icon-art';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');

await fs.mkdir(path.join(BUILD, 'icons'), { recursive: true });
const written: string[] = [];
async function write(file: string, data: string | Buffer): Promise<void> {
  await fs.writeFile(file, data);
  written.push(path.relative(ROOT, file));
}

await write(path.join(BUILD, 'icon.svg'), iconSvg());
await write(path.join(BUILD, 'icon.png'), renderIconPng(ICON_CANVAS));
for (const size of ICON_SIZES) {
  await write(
    path.join(BUILD, 'icons', `${String(size)}x${String(size)}.png`),
    renderIconPng(size),
  );
}
process.stdout.write(`wrote ${written.join(', ')}\n`);
