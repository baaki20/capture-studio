/** Generates the published JSON Schema for project.json from the zod source of truth. */
import { z } from 'zod';
import { PROJECT_FORMAT_VERSION, ProjectV1StructureSchema } from './schema';

export const PROJECT_SCHEMA_ID = `https://capture-studio.invalid/schemas/project-${String(PROJECT_FORMAT_VERSION)}.schema.json`;

export function generateProjectJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ProjectV1StructureSchema, { target: 'draft-2020-12', io: 'input' });
  return {
    ...schema,
    $id: PROJECT_SCHEMA_ID,
    title: 'Capture Studio project (project.json)',
    description:
      'Schema v1 of the Capture Studio project file. Generated from src/shared/project/schema.ts by ' +
      'scripts/gen-schema.ts; do not edit by hand. Cross-field invariants (clip order and overlap, ' +
      'media bounds, minimum clip duration, linked clips, media references) are enforced by the app ' +
      'and are not expressible here.',
  };
}

export function projectJsonSchemaText(): string {
  return JSON.stringify(generateProjectJsonSchema(), null, 2) + '\n';
}
