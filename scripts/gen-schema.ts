/**
 * Writes docs/schemas/project-1.schema.json from the zod schema (spec §4.2, §4.4.1).
 * `npm run gen:schema`; a unit test fails when the committed file is out of date.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectJsonSchemaText } from '../src/shared/project/json-schema';
import { PROJECT_FORMAT_VERSION } from '../src/shared/project/schema';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_PATH = path.join(
  ROOT,
  'docs',
  'schemas',
  `project-${String(PROJECT_FORMAT_VERSION)}.schema.json`,
);

await fs.mkdir(path.dirname(SCHEMA_PATH), { recursive: true });
await fs.writeFile(SCHEMA_PATH, projectJsonSchemaText());
process.stdout.write(`wrote ${path.relative(ROOT, SCHEMA_PATH)}\n`);
