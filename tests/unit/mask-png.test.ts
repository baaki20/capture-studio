/**
 * Mask PNG encoder (§4.3.9 step 3): a valid 8-bit greyscale PNG whose pixels are exactly the
 * render plan's `maskAlpha` (the preview shader's coverage function).
 */
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { maskAlpha, type LayerMask } from '../../src/shared/project/render-plan';
import { encodeGrayPng, maskPng } from '../../src/utility/media/export/mask-png';

interface Decoded {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  pixels: Uint8Array;
}

/** A small PNG reader: checks the signature and every CRC, inflates IDAT, undoes filter 0. */
function decodeGrayPng(png: Buffer): Decoded {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let header: Omit<Decoded, 'pixels'> | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    expect(crc).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] ?? -1,
        colorType: data[9] ?? -1,
      };
      expect([data[10], data[11], data[12]]).toEqual([0, 0, 0]);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    offset += 12 + length;
  }
  expect(ended).toBe(true);
  if (!header) throw new Error('no IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  expect(raw.length).toBe((width + 1) * height);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { ...header, pixels };
}

describe('mask PNG', () => {
  it('round-trips arbitrary greyscale pixels', () => {
    const pixels = Uint8Array.from({ length: 7 * 3 }, (_, i) => (i * 37) % 256);
    const decoded = decodeGrayPng(encodeGrayPng(7, 3, pixels));
    expect(decoded).toMatchObject({ width: 7, height: 3, bitDepth: 8, colorType: 0 });
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  it.each<[string, LayerMask, number, number]>([
    ['circle', { shape: 'circle', radiusPx: 64 }, 128, 128],
    ['rounded', { shape: 'rounded', radiusPx: 24 }, 200, 112],
    ['rectangle', { shape: 'rectangle', radiusPx: 0 }, 10, 6],
  ])('encodes the %s mask exactly as maskAlpha', (_name, mask, width, height) => {
    const decoded = decodeGrayPng(maskPng(mask, width, height));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect(decoded.pixels).toEqual(maskAlpha(mask, width, height));
  });

  it('is opaque at the circle centre, transparent in the corners, soft at the edge', () => {
    const size = 100;
    const { pixels } = decodeGrayPng(maskPng({ shape: 'circle', radiusPx: 50 }, size, size));
    const at = (x: number, y: number) => pixels[y * size + x] ?? -1;
    expect(at(50, 50)).toBe(255);
    expect(at(0, 0)).toBe(0);
    expect(at(99, 99)).toBe(0);
    // On the circle's edge at 45° (pixel centre ~0.2 px outside the radius), coverage is partial.
    const edge = at(14, 14);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it('rejects mismatched sizes', () => {
    expect(() => encodeGrayPng(2, 2, new Uint8Array(3))).toThrow(RangeError);
    expect(() => encodeGrayPng(0, 2, new Uint8Array(0))).toThrow(RangeError);
  });
});
