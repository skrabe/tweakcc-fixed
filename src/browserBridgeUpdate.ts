import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The bridge ships from its own repo, so tweakcc can't know a release exists without asking. Read
// the extension manifest on the default branch: it is the version the installer records, and one
// small unauthenticated GET. Any failure (offline, rate limit, odd payload) means "don't know", and
// the menu simply shows no update line.
export const BRIDGE_MANIFEST_URL =
  'https://raw.githubusercontent.com/skrabe/claude-browser-bridge/master/extension/manifest.json';

export const isNewerVersion = (latest: string, current: string): boolean => {
  const parse = (v: string) => v.split('.').map(n => Number.parseInt(n, 10));
  const a = parse(latest);
  const b = parse(current);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN))
    return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

export const fetchLatestBridgeVersion = async (
  timeoutMs = 3000
): Promise<string | null> => {
  try {
    const res = await fetch(BRIDGE_MANIFEST_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const v =
      body && typeof body === 'object' && 'version' in body
        ? (body as { version: unknown }).version
        : null;
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
};

// The version the bridge installer recorded, or null when the bridge isn't installed.
export const installedBridgeVersion = (): string | null => {
  try {
    const state: unknown = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), '.claude-browser-bridge', 'install-state.json'),
        'utf8'
      )
    );
    const v =
      state && typeof state === 'object' && 'version' in state
        ? (state as { version: unknown }).version
        : null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
};

// The newer version available for an installed bridge, or null (not installed, up to date, offline).
export const bridgeUpdateAvailable = async (): Promise<string | null> => {
  const current = installedBridgeVersion();
  if (!current) return null;
  const latest = await fetchLatestBridgeVersion();
  return latest && isNewerVersion(latest, current) ? latest : null;
};
