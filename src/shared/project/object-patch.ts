/**
 * What `updateObject` may change on a timeline object (v2, R2.5–R2.8), as a zod schema shared by
 * the operation and the automation op schema. Fields that do not belong to the object's kind are
 * refused by the operation; `null` removes an optional field. Ranges are checked by the operation
 * against the project schema.
 */
import { z } from 'zod';
import { FRectSchema, OBJECT_FONTS, StrokeSchema } from './schema';

const Color = z.string();
const Time = z.int().nonnegative();

export const ObjectPatchSchema = z.strictObject({
  inUs: Time.optional(),
  outUs: Time.optional(),
  box: FRectSchema.optional(),
  opacity: z.number().nullable().optional(),
  fadeInUs: Time.nullable().optional(),
  fadeOutUs: Time.nullable().optional(),
  text: z.string().optional(),
  preset: z.string().nullable().optional(),
  style: z
    .strictObject({
      font: z.enum(OBJECT_FONTS).optional(),
      size: z.number().optional(),
      color: Color.optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      background: Color.nullable().optional(),
      outline: StrokeSchema.nullable().optional(),
    })
    .optional(),
  stroke: StrokeSchema.optional(),
  fill: Color.nullable().optional(),
  tail: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  head: z.enum(['triangle', 'open', 'none']).optional(),
  value: z.int().optional(),
  format: z.enum(['1', 'A', 'a', 'I', 'i']).optional(),
  textColor: Color.optional(),
  color: Color.optional(),
  shape: z.enum(['rectangle', 'ellipse']).optional(),
  dim: z.number().optional(),
  radius: z.number().optional(),
  blockSize: z.number().optional(),
});

export type ObjectPatch = z.infer<typeof ObjectPatchSchema>;
