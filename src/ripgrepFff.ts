import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config';

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Map the running platform/arch to the Rust target triple we publish a
 * `rg-fff` binary for. Returns null on unsupported platforms (patch no-ops).
 */
export function getFffTriple(): string | null {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  // NOTE: Intel macOS (x86_64-apple-darwin) intentionally returns null — the
  // .github/workflows/rg-fff.yml build matrix does not produce that asset, so
  // claiming it here only causes a doomed 404 on every --apply (then a correct
  // no-op keeping ripgrep). To support Intel Macs, add a `{ target:
  // x86_64-apple-darwin, os: macos-13 }` matrix leg AND re-add the branch here.
  if (platform === 'linux' && arch === 'arm64')
    return 'aarch64-unknown-linux-musl';
  if (platform === 'linux' && arch === 'x64')
    return 'x86_64-unknown-linux-musl';
  return null;
}

/** Walk up from this module to the repo root (the dir with package.json). */
function findRepoRoot(): { root: string; version: string } | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fsSync.existsSync(pkg)) {
        try {
          const v = JSON.parse(fsSync.readFileSync(pkg, 'utf-8')).version;
          if (typeof v === 'string') return { root: dir, version: v };
        } catch {
          /* keep walking */
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url unavailable */
  }
  return null;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Atomic install: copy to a sibling temp then rename, so dest always gets a
 *  fresh inode (sidesteps the macOS code-signature vnode cache that SIGKILLs an
 *  in-place-overwritten Mach-O — see reference_apply_sigkill_codesign_vnode). */
async function install(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    await fs.copyFile(src, tmp);
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, dest);
  } catch (e) {
    // Clean up the partial temp on failure (matches atomicCopyFile / saveConfigFile
    // / writeJsonIndexFileAtomic), so a failed copy/chmod/rename leaves no orphan.
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function mtimeMs(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Ensure the `rg-fff` wrapper exists for this platform and return its absolute
 * path, or null if unavailable (caller then keeps ripgrep — never half-applies).
 *
 * Resolution order (matches the code below):
 *   1. repo-local build (dev checkout: tools/rg-fff/target/{release,debug}/rg-fff)
 *      — canonical; also REFRESHES dest when the build is newer
 *   2. already installed at ~/.tweakcc/fff/<triple>/rg-fff (published/npx fast path)
 *   3. GitHub release asset rg-fff-<triple> (+ .sha256), for npx installs
 */
export async function ensureRgFffWrapper(): Promise<string | null> {
  const triple = getFffTriple();
  if (!triple) return null;

  // Computed lazily (not at module top-level) so test files that vi.mock
  // './config' don't trip over an undefined CONFIG_DIR during mock hoisting.
  const dest = path.join(CONFIG_DIR, 'fff', triple, 'rg-fff');
  const stamp = path.join(path.dirname(dest), '.version');
  const repo = findRepoRoot();

  // 1. Repo-local build (dev checkout) is canonical — and REFRESH dest whenever
  //    the build is newer, so a rebuilt wrapper actually redeploys (otherwise a
  //    stale binary lingers and the patch points at old behavior).
  if (repo) {
    for (const profile of ['release', 'debug']) {
      const local = path.join(
        repo.root,
        'tools',
        'rg-fff',
        'target',
        profile,
        'rg-fff'
      );
      if (fsSync.existsSync(local)) {
        if ((await mtimeMs(local)) > (await mtimeMs(dest))) {
          await install(local, dest);
        }
        return dest;
      }
    }
  }

  // 2. Published/npx: keep the installed binary, but re-fetch when the tweakcc
  //    version changed (the wrapper is rebuilt per release).
  const version = repo?.version;
  const installedVer = await fs
    .readFile(stamp, 'utf-8')
    .then(s => s.trim())
    .catch(() => null);
  if ((await isExecutable(dest)) && (!version || installedVer === version)) {
    return dest;
  }

  // 3. GitHub release asset (published builds).
  if (!version) return null;
  const base = `https://github.com/skrabe/tweakcc-fixed/releases/download/v${version}`;
  try {
    const binResp = await fetch(`${base}/rg-fff-${triple}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!binResp.ok) return null;
    const bin = Buffer.from(await binResp.arrayBuffer());

    // Verify SHA256 against the published .sha256 (first whitespace-delimited token).
    // FAIL CLOSED: a missing/unreachable/empty/mismatched checksum must keep
    // ripgrep, never install an unverified executable. (Previously this only
    // checked when shaResp.ok && want was truthy, so a 404/429/empty .sha256 fell
    // through to an unconditional, unverified install.)
    const shaResp = await fetch(`${base}/rg-fff-${triple}.sha256`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!shaResp.ok) {
      console.error(
        `patch: swapRipgrepForFff: rg-fff-${triple}.sha256 unavailable (${shaResp.status}) — keeping ripgrep`
      );
      return null;
    }
    const want = (await shaResp.text()).trim().split(/\s+/)[0]?.toLowerCase();
    const got = crypto.createHash('sha256').update(bin).digest('hex');
    if (!want || want !== got) {
      console.error(
        `patch: swapRipgrepForFff: rg-fff-${triple} checksum ${
          want ? 'mismatch' : 'missing'
        } — keeping ripgrep`
      );
      return null;
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, bin);
      await fs.chmod(tmp, 0o755);
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
    await fs.writeFile(stamp, version).catch(() => {});
    return dest;
  } catch {
    return null;
  }
}
