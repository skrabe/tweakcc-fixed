import { execFileSync } from 'node:child_process';

export const findEsExe = (): string | null => {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('where.exe', ['es.exe'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
};

// es.exe exits 8 when it can't reach a running Everything over IPC
export const isEverythingRunning = (esPath: string): boolean => {
  try {
    execFileSync(esPath, ['-get-everything-version'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
};
