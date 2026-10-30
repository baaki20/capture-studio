/**
 * Parent process for `child-lifetime.test.ts`: starts media children the way the utility does,
 * prints their pids as one JSON line, then waits to be killed (or exits when told to).
 *
 * Usage: `node --import tsx orphan-parent.ts <ffmpeg> <workDir> <export|pcm> <setpriv|watchdog|none>
 * [exit]`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  liveChildren,
  setDeathSignalMode,
  type DeathSignalMode,
} from '../../../src/utility/media/child-processes';
import { runFfmpeg } from '../../../src/utility/media/ffmpeg-runner';
import { PcmIngest } from '../../../src/utility/media/pcm-ingest';

const [ffmpegPath = '', workDir = '', kind = 'export', mode = 'setpriv', then = 'wait'] =
  process.argv.slice(2);
setDeathSignalMode(mode as DeathSignalMode);

if (kind === 'pcm') {
  // A stand-in for a stuck pw-record: alive, silent, never closing its stdout.
  new PcmIngest({
    ffmpegPath,
    dir: workDir,
    command: { file: 'sh', args: ['-c', 'exec sleep 3600'] },
  });
} else {
  // A hung export: FFmpeg blocks opening a FIFO nobody writes to, so it never prints progress
  // and never notices its pipes closing (a live encode would die of SIGPIPE on its own).
  const fifo = path.join(workDir, 'stuck.fifo');
  execFileSync('mkfifo', [fifo]);
  void runFfmpeg({
    ffmpegPath,
    args: ['-y', '-f', 's16le', '-i', fifo, path.join(workDir, 'never.wav')],
  });
}

// Report once the children have pids (spawn is synchronous; give the watchdog a tick).
setTimeout(() => {
  const pids = liveChildren()
    .map((child) => ({ pid: child.pid, file: child.spawnfile }))
    .filter((c) => c.pid !== undefined);
  process.stdout.write(`${JSON.stringify(pids)}\n`);
  if (then === 'exit') setTimeout(() => process.exit(0), 300);
}, 300);

setInterval(() => undefined, 60_000);
