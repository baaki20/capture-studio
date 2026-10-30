/**
 * Child process for tests/integration/export.test.ts: runs an export and exits as soon as it
 * makes progress, the way the media utility exits on app quit (`process.exit` after shutdown).
 * Prints the output folder's listing at that moment.
 *
 * Run: tsx exit-mid-export.ts <job.json>
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runExportJob, type ExportJobOptions } from '../../../src/utility/media/export/export-job';

const spec = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as ExportJobOptions;
void runExportJob({
  ...spec,
  onProgress: (fraction) => {
    if (fraction === null || fraction <= 0) return;
    process.stdout.write(JSON.stringify(readdirSync(path.dirname(spec.output))));
    process.exit(0);
  },
});
