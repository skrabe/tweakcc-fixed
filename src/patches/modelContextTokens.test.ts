// Tests for the per-model context window patch (TWEAKCC_MODEL_CONTEXT_TOKENS).
//
// The fixtures below were lifted VERBATIM from the CC 2.1.270 bundle by
// tools/liftModelContextTokensFixtures.mjs — regenerate them with that script
// against a pristine cli.js/binary, do not retype or "clean them up":
//   node tools/liftModelContextTokensFixtures.mjs <path-to-pristine-bundle>
//
// Behaviour, not substrings: both functions are evaluated in a vm context with
// their free variables stubbed so control flow reaches the env-fallback tail,
// and the patched output is compared against the ORIGINAL function's output.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MODEL_CONTEXT_TOKENS_ENV_VAR,
  writeModelContextTokens,
} from './modelContextTokens';

// CC 2.1.270 window sizer (lifted verbatim). Free vars: Rc, Qst, gO, kC, GNn,
// HMt, nh, hz, a, Obe. Model param: `e`. Default: `Obe`.
const SIZER_X270 =
  'function Sz(e,n){if(Rc(e))return 1e6;if(Qst(n)?.includes(gO.header)&&kC(e))return 1e6;let r=GNn(e);if(r!==void 0)return HMt(e)??r.believed;if(nh(e))return 1e6;let s=HMt(e);if(s!==null)return s;let d=a.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(d!==void 0&&d>0&&hz(e))return d;return Obe}';

// CC 2.1.270 unknown-model notice builder (lifted verbatim). Free vars: tw,
// JSr, a, FI, yMt, Un. Model param: `w`.
const NOTICE_X270 =
  'function gb(w,P,U){let{source:H,window:q}=tw(w,P,U);if(H!=="unknown-model")return null;let ee=JSr(w),te=a.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(ee&&te!==void 0&&te>0)return null;let se=q<1e6,we=[];if(!FI()&&se)we.push("append [1m] to the model name for 1M");if(ee)we.push("set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window");let Pe=we.length>0?`; if the model accepts ${se?"more":"less"}, ${we.join(", or ")}`:"";return`${yMt(w)} Until then auto-compact keeps this session within ${Un(q)} tokens (the context window it assumes)${Pe}; CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 restores the previous wait-for-the-API behavior.`}';

const FIXTURE_FILE = `${SIZER_X270}\n${NOTICE_X270}`;
const PATCHED_FIXTURE_FILE = writeModelContextTokens(FIXTURE_FILE);
const ENV = MODEL_CONTEXT_TOKENS_ENV_VAR;

// Stubs that drive the sizer down to its env-fallback tail: not a 1M-tier
// model (Rc/kC/nh false, Qst empty), no declared metadata (GNn undefined), no
// session override (HMt null), the unknown-model env gate passes (hz true),
// CC's own env object is empty (a), default window is 200000 (Obe).
const SIZER_STUBS: Record<string, unknown> = {
  Rc: () => false,
  Qst: () => [],
  gO: { header: 'anthropic-beta' },
  kC: () => false,
  GNn: () => undefined,
  HMt: () => null,
  nh: () => false,
  hz: () => true,
  a: {},
  Obe: 200000,
};

// Stubs for the notice builder: the session resolver reports an unrecognized
// model with a 200k window, DISABLE_COMPACT is unset (JSr false), CC's own env
// object is empty (a).
const NOTICE_STUBS: Record<string, unknown> = {
  tw: () => ({ source: 'unknown-model', window: 200000 }),
  JSr: () => false,
  a: {},
  FI: () => false,
  yMt: (w: unknown) => `"${String(w)}" is not recognized.`,
  Un: (n: unknown) => String(n),
};

// Evaluate `fnName` from `src` in a fresh vm context with the given stubs and
// process.env, and return it bound to that context. vm contexts share the
// isolate, so the function object crosses the boundary by reference.
const evaluate = (
  src: string,
  fnName: string,
  stubs: Record<string, unknown>,
  env: Record<string, string | undefined>
): ((...args: unknown[]) => unknown) => {
  const ctx = vm.createContext({ process: { env }, ...stubs });
  return vm.runInContext(`${src}\n;${fnName}`, ctx) as (
    ...args: unknown[]
  ) => unknown;
};

const callSizer = (
  file: string,
  fnName: string,
  env: Record<string, string | undefined>,
  model: unknown,
  stubs: Record<string, unknown> = SIZER_STUBS
): unknown => evaluate(file, fnName, stubs, env)(model);

const callNotice = (
  file: string,
  fnName: string,
  env: Record<string, string | undefined>,
  model: unknown,
  stubs: Record<string, unknown> = NOTICE_STUBS
): unknown => evaluate(file, fnName, stubs, env)(model);

const sizerOriginal = (
  env: Record<string, string | undefined>,
  model: unknown
): unknown => callSizer(FIXTURE_FILE, 'Sz', env, model);
const sizerPatched = (
  env: Record<string, string | undefined>,
  model: unknown
): unknown => callSizer(PATCHED_FIXTURE_FILE!, 'Sz', env, model);
const noticeOriginal = (
  env: Record<string, string | undefined>,
  model: unknown
): unknown => callNotice(FIXTURE_FILE, 'gb', env, model);
const noticePatched = (
  env: Record<string, string | undefined>,
  model: unknown
): unknown => callNotice(PATCHED_FIXTURE_FILE!, 'gb', env, model);

// Rename every renamable identifier to a $-containing name, deterministically.
// Simulates a future minifier pass churning CC's names: the patch regexes use
// [$\w]+ everywhere and must survive this. Not renamed: keywords, well-known
// globals, property accesses (after `.`), object/destructuring keys (before
// `:`), string and template-literal contents, and numeric-literal exponents
// (`1e6`). Returns the rename map so stubs can be remapped to match.
const KEYWORDS = new Set([
  'function',
  'if',
  'else',
  'return',
  'let',
  'var',
  'const',
  'void',
  'typeof',
  'for',
  'of',
  'in',
  'new',
  'null',
  'true',
  'false',
  'this',
  'class',
  'extends',
  'await',
  'async',
  'yield',
  'throw',
  'try',
  'catch',
  'finally',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'do',
  'while',
  'with',
  'debugger',
  'delete',
  'export',
  'import',
  'super',
  'instanceof',
]);
const GLOBALS = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'Math',
  'Number',
  'String',
  'Object',
  'Array',
  'Boolean',
  'JSON',
  'process',
  'console',
  'isNaN',
  'parseInt',
  'parseFloat',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'Promise',
  'Map',
  'Set',
]);

const renameIdentifiers = (
  src: string
): { src: string; map: Record<string, string> } => {
  const map: Record<string, string> = {};
  let out = '';
  // Frame stack so `${ … }` inside template literals is scanned as code.
  const stack: { kind: 'code' | 'template'; braces: number }[] = [
    { kind: 'code', braces: 0 },
  ];
  let i = 0;
  while (i < src.length) {
    const frame = stack[stack.length - 1];
    const c = src[i];
    if (frame.kind === 'template') {
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        out += c;
        i++;
      } else if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'code', braces: 0 });
        out += '${';
        i += 2;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        j++;
      }
      out += src.slice(i, Math.min(j, src.length));
      i = j;
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'template', braces: 0 });
      out += c;
      i++;
      continue;
    }
    if (c === '{') {
      frame.braces++;
      out += c;
      i++;
      continue;
    }
    if (c === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        stack.pop(); // closes a `${ … }` frame
      } else {
        frame.braces--;
      }
      out += c;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const prevChar = out.length > 0 ? out[out.length - 1] : '';
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      const nextChar = k < src.length ? src[k] : '';
      const isRenameable =
        !/[\w$.]/.test(prevChar) &&
        nextChar !== ':' &&
        !KEYWORDS.has(word) &&
        !GLOBALS.has(word);
      if (isRenameable) {
        if (!(word in map)) map[word] = `$${word}$`;
        out += map[word];
      } else {
        out += word;
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { src: out, map };
};

const remapStubs = (
  map: Record<string, string>,
  stubs: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(stubs).map(([name, value]) => [map[name] ?? name, value])
  );

const LOOKUP_COUNT_RE = /let __tweakccMct=process\.env\./g;
const LOOKUP_BLOCK_RE = /\{let __tweakccMct[\s\S]*?\}\}\}\}\}/g;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeModelContextTokens — anchors and splice mechanics', () => {
  it('splices the verbatim 2.1.270 fixture (two lookups, nothing else touched)', () => {
    expect(PATCHED_FIXTURE_FILE).not.toBeNull();
    expect((PATCHED_FIXTURE_FILE!.match(LOOKUP_COUNT_RE) ?? []).length).toBe(2);
    expect(PATCHED_FIXTURE_FILE!.replace(LOOKUP_BLOCK_RE, '')).toBe(
      FIXTURE_FILE
    );
  });

  it('injects the lookup as the FIRST statement of the window sizer body', () => {
    expect(PATCHED_FIXTURE_FILE).toContain(
      `function Sz(e,n){{let __tweakccMct=process.env.${ENV};`
    );
  });

  it('injects the notice suppression right after the unknown-model source check', () => {
    expect(PATCHED_FIXTURE_FILE).toContain(
      'if(H!=="unknown-model")return null;{let __tweakccMct='
    );
  });

  it('is idempotent — patching an already-patched file returns it unchanged', () => {
    expect(writeModelContextTokens(PATCHED_FIXTURE_FILE!)).toBe(
      PATCHED_FIXTURE_FILE!
    );
  });

  it('no-ops silently on bundles without the env-var hook (CC < 2.1.223)', () => {
    const legacy = 'function Sz(e,n){return 200000}';
    expect(writeModelContextTokens(legacy)).toBe(legacy);
  });

  it('returns null when the window-sizer tail is missing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = FIXTURE_FILE.replace('return Obe}', 'return Obe;}');
    expect(broken).not.toBe(FIXTURE_FILE);
    expect(writeModelContextTokens(broken)).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it('returns null when the window-sizer tail appears twice', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doubled = `${SIZER_X270}\n${SIZER_X270}\n${NOTICE_X270}`;
    expect(writeModelContextTokens(doubled)).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it('returns null when the notice-builder head is missing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = FIXTURE_FILE.replace(
      '"unknown-model"',
      '"unrecognized-model"'
    );
    expect(broken).not.toBe(FIXTURE_FILE);
    expect(writeModelContextTokens(broken)).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it('returns null when the notice-builder head appears twice', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doubled = `${SIZER_X270}\n${NOTICE_X270}\n${NOTICE_X270}`;
    expect(writeModelContextTokens(doubled)).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it('refuses the arrow-function trap instead of splicing an unrelated function', () => {
    // If CC reshapes the sizer into an arrow, the nearest `function` header
    // belongs to an earlier unrelated function — here a decoy whose first
    // param is also `e`. The span from the decoy header to the tail is two
    // statements, so the paren-wrapped parse oracle must reject it and the
    // patch must return null rather than splice into Decoy's body.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = SIZER_X270.slice(SIZER_X270.indexOf('{'));
    const reshaped = `function Decoy(e){return 1}var Sz=(e,n)=>${body}`;
    expect(writeModelContextTokens(`${reshaped}\n${NOTICE_X270}`)).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe('runtime behavior — window sizer (verbatim 2.1.270 fixture)', () => {
  it('returns the configured window for a listed model', () => {
    const env = { [ENV]: 'qwen36-500k:35b=500000,other:8b=131072' };
    expect(sizerPatched(env, 'qwen36-500k:35b')).toBe(500000);
    expect(sizerPatched(env, 'other:8b')).toBe(131072);
  });

  it('matches model IDs case-insensitively', () => {
    const env = { [ENV]: 'Qwen36-500K:35B=500000' };
    expect(sizerPatched(env, 'qwen36-500k:35b')).toBe(500000);
    expect(sizerPatched(env, 'QWEN36-500K:35B')).toBe(500000);
  });

  it('accepts a model object exposing an id', () => {
    const env = { [ENV]: 'qwen36-500k:35b=500000' };
    expect(sizerPatched(env, { id: 'qwen36-500k:35b' })).toBe(500000);
  });

  it('returns exactly what the original returns for an unlisted model', () => {
    const env = { [ENV]: 'qwen36-500k:35b=500000' };
    for (const model of ['claude-sonnet-4-5', 'some:other/model', '']) {
      expect(sizerPatched(env, model)).toBe(sizerOriginal(env, model));
    }
  });

  it('returns exactly what the original returns when the variable is unset or empty', () => {
    const envs: Record<string, string | undefined>[] = [
      {},
      { [ENV]: undefined },
      { [ENV]: '' },
    ];
    for (const env of envs) {
      for (const model of ['qwen36-500k:35b', 'claude-sonnet-4-5']) {
        expect(sizerPatched(env, model)).toBe(sizerOriginal(env, model));
      }
    }
  });

  it('ignores malformed entries', () => {
    const malformed = [
      'garbage',
      '=500000',
      'qwen36-500k:35b=notanumber',
      'qwen36-500k:35b=500000abc',
      'qwen36-500k:35b=',
      'qwen36-500k:35b=0',
      'qwen36-500k:35b=-5',
    ];
    for (const value of malformed) {
      const env = { [ENV]: value };
      expect(sizerPatched(env, 'qwen36-500k:35b')).toBe(
        sizerOriginal(env, 'qwen36-500k:35b')
      );
    }
  });

  it('skips malformed entries but honors well-formed ones around them', () => {
    const env = {
      [ENV]: 'garbage,,qwen36-500k:35b=abc, spaced =7000,other:8b=131072',
    };
    expect(sizerPatched(env, 'spaced')).toBe(7000);
    expect(sizerPatched(env, 'other:8b')).toBe(131072);
    expect(sizerPatched(env, 'qwen36-500k:35b')).toBe(
      sizerOriginal(env, 'qwen36-500k:35b')
    );
  });

  it('splits entries on the LAST = so keys may contain : / and =', () => {
    const env = { [ENV]: 'org/model:v2=beta=131072' };
    expect(sizerPatched(env, 'org/model:v2=beta')).toBe(131072);
  });

  it('takes precedence over CLAUDE_CODE_MAX_CONTEXT_TOKENS for listed models only', () => {
    const stubs = {
      ...SIZER_STUBS,
      a: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 300000 },
    };
    const env = { [ENV]: 'qwen36-500k:35b=500000' };
    expect(
      callSizer(PATCHED_FIXTURE_FILE!, 'Sz', env, 'qwen36-500k:35b', stubs)
    ).toBe(500000);
    // Unlisted models keep CC's own single-integer behavior, untouched.
    expect(callSizer(PATCHED_FIXTURE_FILE!, 'Sz', env, 'unlisted', stubs)).toBe(
      callSizer(FIXTURE_FILE, 'Sz', env, 'unlisted', stubs)
    );
    expect(callSizer(PATCHED_FIXTURE_FILE!, 'Sz', env, 'unlisted', stubs)).toBe(
      300000
    );
  });
});

describe('runtime behavior — unknown-model notice (verbatim 2.1.270 fixture)', () => {
  it('suppresses the notice for a listed model, like CC does when its own variable is set', () => {
    const env = { [ENV]: 'qwen36-500k:35b=500000' };
    expect(noticePatched(env, 'qwen36-500k:35b')).toBeNull();
    expect(noticeOriginal(env, 'qwen36-500k:35b')).not.toBeNull();
  });

  it('leaves the notice untouched for unlisted models', () => {
    const env = { [ENV]: 'qwen36-500k:35b=500000' };
    const original = noticeOriginal(env, 'claude-sonnet-4-5');
    expect(original).toContain('auto-compact keeps this session within');
    expect(noticePatched(env, 'claude-sonnet-4-5')).toBe(original);
  });

  it('leaves the notice untouched when the variable is unset or empty', () => {
    for (const env of [{}, { [ENV]: '' }]) {
      expect(noticePatched(env, 'qwen36-500k:35b')).toBe(
        noticeOriginal(env, 'qwen36-500k:35b')
      );
    }
  });

  it('still shows the notice when the listed entry is malformed', () => {
    const env = { [ENV]: 'qwen36-500k:35b=notanumber' };
    expect(noticePatched(env, 'qwen36-500k:35b')).toBe(
      noticeOriginal(env, 'qwen36-500k:35b')
    );
  });
});

describe('$-containing identifier churn (every renamable identifier renamed)', () => {
  const renamed = renameIdentifiers(FIXTURE_FILE);
  const patchedRenamed = writeModelContextTokens(renamed.src);

  it('actually renames the fixture identifiers to $-containing names', () => {
    expect(renamed.src).not.toContain('function Sz(');
    expect(renamed.src).toContain(`function ${renamed.map['Sz']}(`);
    expect(Object.keys(renamed.map).length).toBeGreaterThan(15);
    for (const name of Object.values(renamed.map)) {
      expect(name).toContain('$');
    }
  });

  it('still finds both anchors and splices exactly two lookups', () => {
    expect(patchedRenamed).not.toBeNull();
    expect((patchedRenamed!.match(LOOKUP_COUNT_RE) ?? []).length).toBe(2);
    expect(patchedRenamed!.replace(LOOKUP_BLOCK_RE, '')).toBe(renamed.src);
  });

  it('honors the variable for a listed model', () => {
    const stubs = remapStubs(renamed.map, SIZER_STUBS);
    const env = { [ENV]: 'qwen36-500k:35b=500000' };
    expect(
      evaluate(
        patchedRenamed!,
        renamed.map['Sz'],
        stubs,
        env
      )('qwen36-500k:35b')
    ).toBe(500000);
  });

  it('returns exactly what the renamed original returns when unlisted or unset', () => {
    const stubs = remapStubs(renamed.map, SIZER_STUBS);
    const cases: [Record<string, string | undefined>, unknown][] = [
      [{ [ENV]: 'qwen36-500k:35b=500000' }, 'claude-sonnet-4-5'],
      [{}, 'qwen36-500k:35b'],
      [{ [ENV]: '' }, 'qwen36-500k:35b'],
      [{ [ENV]: 'garbage' }, 'qwen36-500k:35b'],
    ];
    for (const [env, model] of cases) {
      expect(
        evaluate(patchedRenamed!, renamed.map['Sz'], stubs, env)(model)
      ).toBe(evaluate(renamed.src, renamed.map['Sz'], stubs, env)(model));
    }
  });

  it('suppresses the renamed notice for a listed model only', () => {
    const stubs = remapStubs(renamed.map, NOTICE_STUBS);
    const listed = { [ENV]: 'qwen36-500k:35b=500000' };
    expect(
      evaluate(
        patchedRenamed!,
        renamed.map['gb'],
        stubs,
        listed
      )('qwen36-500k:35b')
    ).toBeNull();
    expect(
      evaluate(
        patchedRenamed!,
        renamed.map['gb'],
        stubs,
        listed
      )('claude-sonnet-4-5')
    ).toBe(
      evaluate(
        renamed.src,
        renamed.map['gb'],
        stubs,
        listed
      )('claude-sonnet-4-5')
    );
  });
});

// Opt-in suite against real pristine bundles (each ~224MB, so this is not part
// of the fast loop): TWEAKCC_MCT_BINARIES=<dir> where <dir>/x*/package/claude
// are pristine CC binaries, e.g. unpacked npm @anthropic-ai/claude-code
// platform tarballs.
const BINARIES_DIR = process.env.TWEAKCC_MCT_BINARIES;
const BINARY_DIRS = BINARIES_DIR
  ? readdirSync(BINARIES_DIR).filter(entry =>
      existsSync(join(BINARIES_DIR, entry, 'package', 'claude'))
    )
  : [];

// Walk back from `anchorStart` to a `function` header whose span to
// `anchorEnd` parses as a single function (same oracle the patch uses), and
// return that span.
const liftPatchedSpan = (
  file: string,
  anchorStart: number,
  anchorEnd: number
): string | null => {
  let i = anchorStart;
  for (let attempt = 0; attempt < 32; attempt++) {
    i = file.lastIndexOf('function', i - 1);
    if (i < 0) return null;
    const prev = i > 0 ? file[i - 1] : ' ';
    if (/[$\w.]/.test(prev)) continue;
    const span = file.slice(i, anchorEnd);
    try {
      new vm.Script(`(${span})`);
    } catch {
      continue;
    }
    return span;
  }
  return null;
};

// Naive brace-match from a function header to its closing brace. Test-only
// validation aid for the small (~650B) notice function; the patch itself
// never needs the notice function's end.
const functionEndFrom = (file: string, headerIdx: number): number => {
  const open = file.indexOf('{', headerIdx);
  if (open < 0) return -1;
  let depth = 0;
  for (let j = open; j < file.length; j++) {
    const c = file[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
  }
  return -1;
};

const SIZER_TAIL_RE =
  /let ([$\w]+)=([$\w]+)\.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if\(\1!==void 0&&\1>0&&[$\w]+\(([$\w]+)\)\)return \1;return ([$\w]+)\}/g;
const NOTICE_HEAD_RE =
  /let\{source:([$\w]+),window:([$\w]+)\}=([$\w]+)\(([$\w]+)[^)]*\);if\(\1!=="unknown-model"\)return null;/g;

describe.skipIf(!BINARIES_DIR)(
  'real pristine CC binaries (TWEAKCC_MCT_BINARIES)',
  () => {
    it.each(BINARY_DIRS)(
      'patches %s cleanly and both spliced functions still parse',
      entry => {
        const binary = join(BINARIES_DIR!, entry, 'package', 'claude');
        const src = readFileSync(binary, 'latin1');
        const patched = writeModelContextTokens(src);
        expect(patched).not.toBeNull();
        expect(patched!.length).toBeGreaterThan(src.length);
        expect((patched!.match(LOOKUP_COUNT_RE) ?? []).length).toBe(2);

        // The spliced window sizer must still parse as a single function that
        // contains the injected lookup.
        const tails = [...patched!.matchAll(SIZER_TAIL_RE)];
        expect(tails).toHaveLength(1);
        const tail = tails[0];
        const sizerSpan = liftPatchedSpan(
          patched!,
          tail.index!,
          tail.index! + tail[0].length
        );
        expect(sizerSpan).not.toBeNull();
        expect(sizerSpan).toContain('let __tweakccMct=process.env.');

        // Same for the notice builder: walk back to its header, brace-match to
        // its end, and run the parse oracle over the spliced span.
        const notices = [...patched!.matchAll(NOTICE_HEAD_RE)];
        expect(notices).toHaveLength(1);
        const notice = notices[0];
        let noticeSpan: string | null = null;
        let h = notice.index!;
        for (let attempt = 0; attempt < 32 && !noticeSpan; attempt++) {
          h = patched!.lastIndexOf('function', h - 1);
          if (h < 0) break;
          const prev = h > 0 ? patched![h - 1] : ' ';
          if (/[$\w.]/.test(prev)) continue;
          const end = functionEndFrom(patched!, h);
          if (end <= notice.index! + notice[0].length) continue;
          noticeSpan = liftPatchedSpan(patched!, notice.index!, end);
        }
        expect(noticeSpan).not.toBeNull();
        expect(noticeSpan).toContain('let __tweakccMct=process.env.');
      }
    );
  }
);
