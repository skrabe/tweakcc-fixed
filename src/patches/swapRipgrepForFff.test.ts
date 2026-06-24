import { describe, expect, it, vi } from 'vitest';
import { writeSwapRipgrepForFff } from './swapRipgrepForFff';

const WRAPPER = '/Users/x/.tweakcc/fff/aarch64-apple-darwin/rg-fff';
const WQ = JSON.stringify(WRAPPER); // "..."

// The grep/find shadow template as CC's snapshot-generator emits it (3× "$_cc_bin").
const SHADOW =
  'function grep {\n' +
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"\n' +
  '  [[ -x $_cc_bin ]] || _cc_bin=/Users/x/.local/bin/claude\n' +
  '  if [[ ! -x $_cc_bin ]]; then command grep "$@"; return; fi\n' +
  '  if [[ -n "${ZSH_VERSION:-}" ]]; then\n' +
  '    ARGV0=${t} "$_cc_bin" ${o}\n' +
  '  elif [[ "$OSTYPE" == "msys" ]]; then\n' +
  '    ARGV0=${t} "$_cc_bin" ${o}\n' +
  '  else\n' +
  '    (exec -a ${t} "$_cc_bin" ${o})\n' +
  '  fi\n}';

const DESCRIPTOR =
  '{mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"}';
const RESOLVER = `if(Af()){let n=${DESCRIPTOR};return n}`;

const BT = '`';
const GREP_DESC = `;function gVr(e){if(xh(e))return${BT}Content search built on ripgrep. Bare identifiers.${BT};return${BT}A powerful search tool built on ripgrep. Full regex syntax.${BT}}`;

// Two Bash-description variants (concise + full), each ending the dedicated-tool
// bullet with the PRISTINE phrasing "Prefer dedicated tools over ${o} ..." (verified
// in the real cli.js backup) — the append target for the main agent. (The earlier
// fixture used "Prefer the dedicated tool.", which only exists in LCC overrides, so
// it gave false green while the public/default anchor matched nothing.)
const BASH_DESC =
  `;var bashHelp=[${BT}- Use Read to read files, not cat.${BT},` +
  `${BT}- Avoid search commands; prefer dedicated tools after verifying. Prefer dedicated tools over \${o} when one fits.${BT},` +
  `${BT}- \\\`timeout\\\` is in ms.${BT}];` +
  `var bashHelp2=[${BT}- Avoid cat/head/tail. Prefer dedicated tools over \${o} when one fits.${BT}];`;

const COMBINED = SHADOW + RESOLVER + GREP_DESC + BASH_DESC;

const countOf = (s: string, sub: string) => s.split(sub).length - 1;

describe('swapRipgrepForFff', () => {
  it('repoints all 3 bash-search shadow sites at the wrapper', () => {
    const out = writeSwapRipgrepForFff(COMBINED, WRAPPER);
    expect(out).not.toBeNull();
    expect(out).not.toContain('"$_cc_bin"');
    // wrapper appears 3× (shadow) + 1× (rg resolver) = 4
    expect(countOf(out!, WRAPPER)).toBeGreaterThanOrEqual(4);
    expect(out).toContain('ARGV0=${t} ' + WQ);
    expect(out).toContain('exec -a ${t} ' + WQ);
  });

  it('also repoints the rg resolver and appends fff guidance to both grep variants', () => {
    const out = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    expect(out).toContain('--fff-claude-bin='); // rg resolver
    expect(out).not.toContain('mode:"embedded"');
    expect(countOf(out, 'Search backend note (fff):')).toBe(2); // concise + full
  });

  it('appends minimal ranking/--fuzzy guidance to both Bash description variants', () => {
    const out = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    expect(countOf(out, 'most-relevant-first')).toBe(2); // both bash variants
    expect(out).toContain('grep --fuzzy SomeName');
    // inserted inside the bullet (after the pristine phrasing), before its closing
    // backtick (no raw backticks)
    expect(out).toContain('when one fits. grep/find results are ranked');
    // the structured Grep tool has no --fuzzy flag, so its desc must NOT mention it
    const grepNote = out.slice(out.indexOf('Search backend note (fff):'));
    expect(grepNote.slice(0, 120)).not.toContain('--fuzzy');
  });

  it('is idempotent (no-op when already applied)', () => {
    const once = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    const twice = writeSwapRipgrepForFff(once, WRAPPER);
    expect(twice).toBe(once);
  });

  it('succeeds on a shadow-only file (rg/guidance are best-effort)', () => {
    const out = writeSwapRipgrepForFff(SHADOW, WRAPPER);
    expect(out).not.toBeNull();
    expect(out).not.toContain('"$_cc_bin"');
    // 3 repointed invocations (2 ARGV0 + 1 exec-a) + 1 in the -x guard = 4
    expect(countOf(out!, WRAPPER)).toBe(4);
    expect(out).toContain('|| ! -x ' + WQ); // wrapper-executable guard
  });

  it('returns null (critical) when the shadow anchor is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // RESOLVER alone has no "$_cc_bin" shadow token.
      expect(writeSwapRipgrepForFff(RESOLVER, WRAPPER)).toBeNull();
      expect(errSpy).toHaveBeenCalledWith(
        'patch: swapRipgrepForFff: bash-search shadow anchor "$_cc_bin" not found'
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('injects shell-valid wrapper paths (quoted)', () => {
    const out = writeSwapRipgrepForFff(SHADOW, WRAPPER)!;
    // each repointed invocation is ARGV0=${t} "<path>" ${o} or exec -a ${t} "<path>" ${o}
    expect(out).toContain('ARGV0=${t} ' + WQ + ' ${o}');
    expect(out).toContain('(exec -a ${t} ' + WQ + ' ${o})');
  });

  it('escapes non-ASCII / backtick / ${} in the wrapper path for the backtick shadow', () => {
    // A path with a non-ASCII char, a backtick, and a ${} — all hazards in the
    // backtick-template shadow (Bun Latin-1 mojibake / template-termination /
    // interpolation → the "function wrapper" boot crash).
    const tricky = '/Users/José/`x${HOME}/rg-fff';
    const out = writeSwapRipgrepForFff(SHADOW, tricky)!;
    expect(out).not.toBeNull();
    expect(out).not.toContain('José'); // no RAW non-ASCII byte in cli.js
    expect(out).toContain('Jos\\u00e9'); // escaped to \uXXXX
    expect(out).toContain('\\`'); // backtick escaped, can't terminate the template
    expect(out).toContain('\\${HOME}'); // ${ escaped, no live interpolation
    // the guard now also gates on the wrapper being executable
    expect(out).toContain('|| ! -x ');
  });
});
