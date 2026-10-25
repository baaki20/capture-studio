/**
 * Mask PNGs for the export (§4.3.9 step 3): the overlay mask rasterized with the same
 * anti-aliased coverage function the preview shader uses (`maskAlpha` in `render-plan.ts`), and
 * written with a minimal PNG encoder on `node:zlib`: 8-bit greyscale, one IDAT, no filtering.
 */
import { promises as fs } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { maskAlpha, type LayerMask } from '../../../shared/project/render-plan';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes row-major 8-bit greyscale pixels (`width × height` bytes) as a PNG. */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`invalid PNG size ${String(width)}×${String(height)}`);
  }
  if (pixels.length !== width * height) {
    throw new RangeError(`expected ${String(width * height)} pixels, got ${String(pixels.length)}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  // Each scanline starts with its filter type (0 = None).
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The mask of a `width × height` overlay as a greyscale PNG (255 = opaque). */
export function maskPng(mask: LayerMask, width: number, height: number): Buffer {
  return encodeGrayPng(width, height, maskAlpha(mask, width, height));
}

export async function writeMaskPng(
  file: string,
  mask: LayerMask,
  width: number,
  height: number,
): Promise<void> {
  await fs.writeFile(file, maskPng(mask, width, height));
}
