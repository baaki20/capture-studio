/**
 * Draws text and callouts (R2.5, R2.6) with canvas 2D, from the draw plan in
 * `shared/project/objects.ts`, for the compositor to place. The preview worker and the export's
 * render window run this same code with the same bundled fonts (`object-fonts.ts`), so both show
 * the same pixels (plan risk 2). Pictures are cached by their plan key; text waits for the fonts.
 *
 * Text: lines break at newlines and wrap at word boundaries to the box's width (less the
 * background's padding), centred vertically in the box. The outline is drawn under the fill.
 * Shapes: strokes lie inside the box. Arrows run from the tail corner to the opposite one with
 * the head on the far end. Steps are a filled circle with the label. Spotlights darken the frame
 * outside the box.
 */
import {
  arrowEnds,
  arrowHeadPx,
  stepLabel,
  wrapLines,
  type ObjectDrawPlan,
  type PxRect,
} from '../../../shared/project/objects';
import type { CompositeObjectOf } from './compositor-math';
import { FONT_FAMILIES, objectFontsLoaded } from './object-fonts';

type RasterPlan = Extract<ObjectDrawPlan, { kind: 'raster' }>;
type Ctx = OffscreenCanvasRenderingContext2D;

/** Pictures kept for reuse (moving objects keep their picture; edits make new ones). */
const CACHE_SIZE = 64;

function roundedRect(ctx: Ctx, r: PxRect, radius: number): void {
  const rr = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, rr);
}

function drawText(ctx: Ctx, plan: RasterPlan): void {
  if (plan.item.kind !== 'text') return;
  const { style, text } = plan.item;
  const box = plan.inner;
  const fontPx = style.size * plan.heightPx;
  ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${String(fontPx)}px "${FONT_FAMILIES[style.font]}"`;
  const pad = style.background ? fontPx * 0.35 : 0;
  if (style.background) {
    ctx.fillStyle = style.background;
    roundedRect(ctx, box, fontPx * 0.25);
    ctx.fill();
  }
  const lines = wrapLines(ctx, text, Math.max(1, box.width - 2 * pad));
  const lineHeight = fontPx * 1.25;
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const blockHeight = (lines.length - 1) * lineHeight + ascent + descent;
  let y = box.y + (box.height - blockHeight) / 2 + ascent;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = style.align;
  const x =
    style.align === 'left'
      ? box.x + pad
      : style.align === 'right'
        ? box.x + box.width - pad
        : box.x + box.width / 2;
  for (const line of lines) {
    if (style.outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2 * style.outline.width * plan.unitPx;
      ctx.strokeStyle = style.outline.color;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
}

function drawPlan(ctx: Ctx, plan: RasterPlan): void {
  const { item, inner: box, unitPx } = plan;
  switch (item.kind) {
    case 'text':
      drawText(ctx, plan);
      return;
    case 'rectangle':
    case 'ellipse': {
      const lw = item.stroke.width * unitPx;
      const inset = {
        x: box.x + lw / 2,
        y: box.y + lw / 2,
        width: Math.max(0, box.width - lw),
        height: Math.max(0, box.height - lw),
      };
      ctx.beginPath();
      if (item.kind === 'rectangle') ctx.rect(inset.x, inset.y, inset.width, inset.height);
      else {
        ctx.ellipse(
          inset.x + inset.width / 2,
          inset.y + inset.height / 2,
          inset.width / 2,
          inset.height / 2,
          0,
          0,
          Math.PI * 2,
        );
      }
      if (item.fill) {
        ctx.fillStyle = item.fill;
        ctx.fill();
      }
      if (lw > 0) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = item.stroke.color;
        ctx.stroke();
      }
      return;
    }
    case 'arrow': {
      const lw = Math.max(1, item.stroke.width * unitPx);
      const head = item.head === 'none' ? 0 : arrowHeadPx(item.stroke.width * unitPx);
      const { from, to } = arrowEnds(item.tail, box.width, box.height);
      const fx = box.x + from[0];
      const fy = box.y + from[1];
      const tx = box.x + to[0];
      const ty = box.y + to[1];
      const angle = Math.atan2(ty - fy, tx - fx);
      const length = Math.hypot(tx - fx, ty - fy);
      // A filled head covers the line's last part; an open one leaves it.
      const lineEnd = item.head === 'triangle' ? Math.max(0, length - head * 0.8) : length;
      ctx.strokeStyle = item.stroke.color;
      ctx.fillStyle = item.stroke.color;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + Math.cos(angle) * lineEnd, fy + Math.sin(angle) * lineEnd);
      ctx.stroke();
      if (head > 0) {
        const spread = Math.PI / 7;
        const left = [tx - head * Math.cos(angle - spread), ty - head * Math.sin(angle - spread)];
        const right = [tx - head * Math.cos(angle + spread), ty - head * Math.sin(angle + spread)];
        ctx.beginPath();
        ctx.moveTo(left[0] ?? 0, left[1] ?? 0);
        ctx.lineTo(tx, ty);
        ctx.lineTo(right[0] ?? 0, right[1] ?? 0);
        if (item.head === 'triangle') {
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.stroke();
        }
      }
      return;
    }
    case 'step': {
      const d = Math.min(box.width, box.height);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = item.fill;
      ctx.fill();
      const label = stepLabel(item.value, item.format);
      let fontPx = d * 0.55;
      ctx.font = `700 ${String(fontPx)}px "${FONT_FAMILIES.sans}"`;
      const width = ctx.measureText(label).width;
      if (width > d * 0.75) {
        fontPx *= (d * 0.75) / width;
        ctx.font = `700 ${String(fontPx)}px "${FONT_FAMILIES.sans}"`;
      }
      const m = ctx.measureText(label);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = item.textColor;
      ctx.fillText(label, cx, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
      return;
    }
    case 'highlight':
      ctx.fillStyle = item.color;
      ctx.fillRect(box.x, box.y, box.width, box.height);
      return;
    case 'spotlight':
      ctx.fillStyle = `rgba(0, 0, 0, ${String(item.dim)})`;
      ctx.fillRect(0, 0, plan.size.width, plan.size.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      if (item.shape === 'rectangle') ctx.rect(box.x, box.y, box.width, box.height);
      else {
        ctx.ellipse(
          box.x + box.width / 2,
          box.y + box.height / 2,
          box.width / 2,
          box.height / 2,
          0,
          0,
          Math.PI * 2,
        );
      }
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      return;
    case 'blur':
    case 'pixelate':
      return;
  }
}

/** Uses text (so it must wait for the fonts). */
function needsFonts(plan: RasterPlan): boolean {
  return plan.item.kind === 'text' || plan.item.kind === 'step';
}

export class ObjectRasterizer {
  private readonly cache = new Map<string, OffscreenCanvas>();

  constructor(private readonly fontsReady: () => boolean = objectFontsLoaded) {}

  /** The plan's picture, or null while its fonts are still loading. */
  picture(plan: RasterPlan): OffscreenCanvas | null {
    const cached = this.cache.get(plan.key);
    if (cached) {
      // Most recently used last.
      this.cache.delete(plan.key);
      this.cache.set(plan.key, cached);
      return cached;
    }
    if (needsFonts(plan) && !this.fontsReady()) return null;
    const canvas = new OffscreenCanvas(plan.size.width, plan.size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('object rasteriser: no 2D context');
    drawPlan(ctx, plan);
    this.cache.set(plan.key, canvas);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return canvas;
  }

  /**
   * The compositor's objects for draw plans; `complete` is false when a picture is missing
   * (its fonts are loading), so the caller draws again once they are.
   */
  objects(plans: readonly ObjectDrawPlan[]): {
    objects: CompositeObjectOf<OffscreenCanvas>[];
    complete: boolean;
  } {
    const objects: CompositeObjectOf<OffscreenCanvas>[] = [];
    let complete = true;
    for (const plan of plans) {
      if (plan.kind !== 'raster') {
        objects.push(plan);
        continue;
      }
      const image = this.picture(plan);
      if (!image) {
        complete = false;
        continue;
      }
      objects.push({ kind: 'image', key: plan.key, image, rect: plan.rect, opacity: plan.opacity });
    }
    return { objects, complete };
  }
}
