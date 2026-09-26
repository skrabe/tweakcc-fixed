// Where the pristine-bundle gates find the cli.js they grade patches against.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// tweakcc stamps its own marker into everything it splices, so a file carrying
// one is a PATCHED binary's JS, not pristine — patching it again proves nothing.
const isPristine = (src: string): boolean => !src.includes('__tweakcc');

// A bump leaves several bundles in /tmp at once: the local darwin extraction
// plus one rsynced from each Linux box for the cross-platform gate. Those are
// DIFFERENT minify targets, so grading this host's patches against a remote
// bundle proves nothing about the binary being patched — and mtime order picks
// whichever rsync finished last. Prefer the host-less `cli-<version>.js` name
// the local extraction uses, and fall back to mtime only among equals.
const isHostTagged = (file: string): boolean =>
  /^cli-(?!\d)[^/]*-\d+\.\d+\.\d+\.js$/.test(path.basename(file));

export const findPristineCliJs = (): {
  path: string;
  source: string;
} | null => {
  const candidates: string[] = [];
  // An explicit choice always wins, so a caller can grade a specific bundle.
  if (process.env.TWEAKCC_PRISTINE_CLI) {
    candidates.push(process.env.TWEAKCC_PRISTINE_CLI);
  }
  candidates.push(
    path.join(os.homedir(), '.tweakcc', 'native-claudejs-orig.js')
  );
  try {
    const tmpMatches = fs
      .readdirSync('/tmp')
      .filter(f => /^cli-.*\.js$/.test(f))
      .map(f => path.join('/tmp', f))
      .sort((a, b) => {
        const tagged = Number(isHostTagged(a)) - Number(isHostTagged(b));
        if (tagged !== 0) return tagged;
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      });
    candidates.push(...tmpMatches);
  } catch {
    // no /tmp listing available; the home candidate still stands
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, 'utf8');
    if (!isPristine(source)) continue;
    return { path: candidate, source };
  }
  return null;
};

export const NOT_ENABLED =
  'TWEAKCC_PRISTINE_PATCHES=1 not set — run `pnpm test:pristine`';

export const NO_PRISTINE_CLI_JS =
  'no pristine cli.js found (looked for ~/.tweakcc/native-claudejs-orig.js ' +
  'and /tmp/cli-*.js) — run tweakcc --apply once against a local Claude ' +
  'Code install, or drop an extracted cli.js at /tmp/cli-<version>.js';
