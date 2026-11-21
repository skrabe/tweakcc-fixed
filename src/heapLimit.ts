import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as v8 from 'node:v8';

// Applying the full prompt catalogue to Claude Code 2.1.330 peaks at about
// 5 GB of heap, past Node's usual 4 GB default, and the apply dies with
// "JavaScript heap out of memory". Re-run once with a larger old space unless
// the caller already chose one.
const TARGET_HEAP_MB = 8192;
const REEXEC_ENV = 'TWEAKCC_HEAP_REEXEC';

export const heapPlan = ({
  limitMb,
  totalMemMb,
  execArgv,
  nodeOptions,
  alreadyReexeced,
}: {
  limitMb: number;
  totalMemMb: number;
  execArgv: readonly string[];
  nodeOptions: string;
  alreadyReexeced: boolean;
}): number | null => {
  if (alreadyReexeced) return null;
  const chosen = [...execArgv, ...nodeOptions.split(/\s+/)].some(a =>
    a.startsWith('--max-old-space-size')
  );
  if (chosen) return null;
  const target = Math.min(TARGET_HEAP_MB, Math.floor(totalMemMb * 0.75));
  return target > limitMb ? target : null;
};

export const ensureHeapLimit = (): void => {
  const target = heapPlan({
    limitMb: v8.getHeapStatistics().heap_size_limit / 1024 / 1024,
    totalMemMb: os.totalmem() / 1024 / 1024,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    alreadyReexeced: process.env[REEXEC_ENV] === '1',
  });
  if (target === null) return;
  const result = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      `--max-old-space-size=${target}`,
      ...process.argv.slice(1),
    ],
    { stdio: 'inherit', env: { ...process.env, [REEXEC_ENV]: '1' } }
  );
  if (result.error) return;
  process.exit(result.status ?? (result.signal ? 1 : 0));
};
