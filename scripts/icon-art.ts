/**
 * The Capture Studio app icon (spec §4.5 step 20): an original drawing of a screen with a record
 * dot on a rounded-square tile. One shape list feeds both outputs, so the SVG and the PNGs always
 * match: `iconSvg()` writes it as SVG, `renderIconPng()` rasterizes it with signed-distance
 * anti-aliasing and encodes an 8-bit RGBA PNG on `node:zlib`.
 */
import { crc32, deflateSync } from 'node:zlib';

/** The drawing's coordinate space (a 512 × 512 canvas). */
export const ICON_CANVAS = 512;
/** PNG sizes installed into the hicolor theme (`build/icons/<n>x<n>.png`). */
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;

type Rgb = readonly [number, number, number];

interface RoundedRect {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

interface Circle {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
}

/** A filled shape, or the outline of one when `stroke` (the line width) is set. */
interface Layer {
  shape: RoundedRect | Circle;
  /** A flat colour, or a top-to-bottom gradient over the shape's height. */
  fill: Rgb | { top: Rgb; bottom: Rgb };
  stroke?: number;
}

const WHITE: Rgb = [0xf5, 0xf7, 0xfa];

export const ICON_LAYERS: readonly Layer[] = [
  // Tile
  {
    shape: { kind: 'rect', x: 32, y: 32, width: 448, height: 448, radius: 96 },
    fill: { top: [0x2f, 0x55, 0x8c], bottom: [0x16, 0x27, 0x42] },
  },
  // Screen
  {
    shape: { kind: 'rect', x: 108, y: 132, width: 296, height: 208, radius: 28 },
    fill: WHITE,
    stroke: 24,
  },
  // Stand
  {
    shape: { kind: 'rect', x: 196, y: 368, width: 120, height: 26, radius: 13 },
    fill: WHITE,
  },
  // Record dot
  { shape: { kind: 'circle', cx: 256, cy: 236, r: 56 }, fill: [0xff, 0x4d, 0x4f] },
];

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The icon as a standalone SVG document (`build/icon.svg`). */
export function iconSvg(): string {
  const defs: string[] = [];
  const body: string[] = [];
  ICON_LAYERS.forEach((layer, index) => {
    let paint: string;
    if ('top' in layer.fill) {
      const id = `fill${String(index)}`;
      defs.push(
        `    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`,
        `      <stop offset="0" stop-color="${hex(layer.fill.top)}"/>`,
        `      <stop offset="1" stop-color="${hex(layer.fill.bottom)}"/>`,
        '    </linearGradient>',
      );
      paint = `url(#${id})`;
    } else {
      paint = hex(layer.fill);
    }
    const style =
      layer.stroke === undefined
        ? `fill="${paint}"`
        : `fill="none" stroke="${paint}" stroke-width="${String(layer.stroke)}"`;
    const s = layer.shape;
    if (s.kind === 'circle') {
      body.push(
        `  <circle cx="${String(s.cx)}" cy="${String(s.cy)}" r="${String(s.r)}" ${style}/>`,
      );
    } else {
      // A stroke is centred on the path, so the outline's path is inset by half the line width
      // to keep the stroke inside the rectangle, as the rasterizer draws it.
      const inset = (layer.stroke ?? 0) / 2;
      body.push(
        `  <rect x="${String(s.x + inset)}" y="${String(s.y + inset)}" ` +
          `width="${String(s.width - 2 * inset)}" height="${String(s.height - 2 * inset)}" ` +
          `rx="${String(s.radius - inset)}" ${style}/>`,
      );
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(ICON_CANVAS)}" height="${String(ICON_CANVAS)}" viewBox="0 0 ${String(ICON_CANVAS)} ${String(ICON_CANVAS)}">`,
    '  <title>Capture Studio</title>',
    ...(defs.length > 0 ? ['  <defs>', ...defs, '  </defs>'] : []),
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

/** Signed distance from (px, py) to the shape's edge: negative inside, positive outside. */
function distance(shape: RoundedRect | Circle, px: number, py: number): number {
  if (shape.kind === 'circle') return Math.hypot(px - shape.cx, py - shape.cy) - shape.r;
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  const qx = Math.abs(px - (shape.x + hw)) - (hw - shape.radius);
  const qy = Math.abs(py - (shape.y + hh)) - (hh - shape.radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - shape.radius;
}

function layerColor(layer: Layer, py: number): Rgb {
  if (!('top' in layer.fill)) return layer.fill;
  const s = layer.shape;
  const [top, height] = s.kind === 'circle' ? [s.cy - s.r, 2 * s.r] : [s.y, s.height];
  const t = Math.min(Math.max((py - top) / height, 0), 1);
  const { top: a, bottom: b } = layer.fill;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Rasterizes the icon at `size` × `size`: straight (not premultiplied) RGBA, row-major. */
export function rasterizeIcon(size: number): Uint8Array {
  if (!Number.isInteger(size) || size <= 0)
    throw new RangeError(`invalid icon size ${String(size)}`);
  const scale = ICON_CANVAS / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const py = (y + 0.5) * scale;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const layer of ICON_LAYERS) {
        let d = distance(layer.shape, px, py);
        if (layer.stroke !== undefined) d = Math.max(d, -d - layer.stroke);
        // Coverage of a one-pixel-wide box filter across the edge.
        const coverage = Math.min(Math.max(0.5 - d / scale, 0), 1);
        if (coverage === 0) continue;
        const [cr, cg, cb] = layerColor(layer, py);
        // Source-over in premultiplied space.
        r = cr * coverage + r * (1 - coverage);
        g = cg * coverage + g * (1 - coverage);
        b = cb * coverage + b * (1 - coverage);
        a = coverage + a * (1 - coverage);
      }
      const i = (y * size + x) * 4;
      out[i] = a > 0 ? Math.round(r / a) : 0;
      out[i + 1] = a > 0 ? Math.round(g / a) : 0;
      out[i + 2] = a > 0 ? Math.round(b / a) : 0;
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes straight RGBA pixels as an 8-bit PNG (colour type 6, one IDAT, no filtering). */
export function encodeRgbaPng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height * 4) {
    throw new RangeError(
      `expected ${String(width * height * 4)} bytes, got ${String(pixels.length)}`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderIconPng(size: number): Buffer {
  return encodeRgbaPng(size, size, rasterizeIcon(size));
}
