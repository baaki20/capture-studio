/**
 * PNG encoding of preview captures (for assistants' frame snapshots). Uses the DOM's
 * `OffscreenCanvas`, so it lives apart from the unit-tested automation handler.
 */
import type { CapturedPng } from '../automation';

/** Encodes a top-down RGBA frame as PNG, scaled down to at most `maxWidth` wide. */
export async function encodePng(
  picture: { width: number; height: number; rgba: Uint8Array<ArrayBuffer> },
  maxWidth: number,
): Promise<CapturedPng> {
  const scale = Math.min(1, maxWidth / picture.width);
  const width = Math.max(1, Math.round(picture.width * scale));
  const height = Math.max(1, Math.round(picture.height * scale));
  const source = await createImageBitmap(
    new ImageData(
      new Uint8ClampedArray(picture.rgba.buffer, picture.rgba.byteOffset, picture.rgba.byteLength),
      picture.width,
      picture.height,
    ),
  );
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  context.drawImage(source, 0, 0, width, height);
  source.close();
  const bytes = new Uint8Array(
    await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
  );
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { pngBase64: btoa(binary), width, height };
}
