import { spawn } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';

export const TARGET_HEAP_MB = 8192;
export const HEAP_RAISED_ENV = 'TWEAKCC_HEAP_RAISED';

const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(=|$)/;
const INSPECT_FLAG = /^--inspect/;
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function shouldRaiseHeap(
  heapLimitBytes: number,
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
  isBun = false
): boolean {
  if (isBun) return false;
  if (env[HEAP_RAISED_ENV]) return false;
  if (heapLimitBytes >= (TARGET_HEAP_MB - 512) * 1024 * 1024) return false;
  if (execArgv.some(a => HEAP_FLAG.test(a) || INSPECT_FLAG.test(a))) {
    return false;
  }
  const nodeOptions = (env.NODE_OPTIONS ?? '').split(/\s+/);
  if (nodeOptions.some(a => HEAP_FLAG.test(a) || INSPECT_FLAG.test(a))) {
    return false;
  }
  return true;
}

export async function relaunchWithLargerHeap(): Promise<boolean> {
  if (
    !shouldRaiseHeap(
      getHeapStatistics().heap_size_limit,
      process.env,
      process.execArgv,
      Boolean(process.versions.bun)
    )
  ) {
    return false;
  }
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${TARGET_HEAP_MB}`,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { stdio: 'inherit', env: { ...process.env, [HEAP_RAISED_ENV]: '1' } }
  );
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  const stopForwarding = () => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  };
  return new Promise<boolean>(resolve => {
    child.once('error', () => {
      stopForwarding();
      resolve(false);
    });
    child.once('exit', (code, signal) => {
      stopForwarding();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  });
}
