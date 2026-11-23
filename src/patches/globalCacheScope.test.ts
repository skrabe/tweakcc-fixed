import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  identityLiterals,
  pristineIdentityOf,
  writeNoGlobalCacheScope,
} from './globalCacheScope';

// The identity set, the predicate, the one caller that builds its own global
// marker, and the system prompt's scope split, as CC 2.1.280 minifies them,
// kept byte-for-byte so a shape change upstream turns these red.
const IDENTITY =
  'var i="You are Claude Code, Anthropic\'s official CLI for Claude.",u="You are Claude Code, Anthropic\'s official CLI for Claude, running within the Claude Agent SDK.",f="You are a Claude agent, built on Anthropic\'s Claude Agent SDK.",g=[i,u,f],K9t=new Set(g)';
const PREDICATE =
  'function $Ie(){if(!Ug())return!1;if(!ms())return!1;let e=Me();return e==="firstParty"||e==="anthropicAws"}';
const CALLER =
  'let oe=SH({ttl:n$("agent_classifier")?"1h":void 0,scope:$Ie()?"global":void 0})';
const SPLIT =
  'function bSe(e,n){let r=$Ie(),s=e.findIndex((H)=>H===$L);if(r&&n?.skipGlobalCacheForSystemPrompt&&s===-1){i("tengu_sysprompt_using_tool_based_cache",{promptBlockCount:e.length});let H,j,he,_e=[];for(let xe of e){if(!xe)continue;if(xe===$L)continue;if(xe.startsWith(_Pe))H=xe;else if(K9t.has(xe))j=xe;else if(xe===EQe)he=xe;else _e.push(xe)}let ke=[];if(H)ke.push({text:H,cacheScope:null});if(j)ke.push({text:j,cacheScope:"org"});if(he&&H&&j)ke.push({text:he,cacheScope:null});let ve=_e.join(`\n\n`);if(ve)ke.push({text:ve,cacheScope:"org"});return ke}if(r)if(s!==-1){let H,j,he,_e=[],ke=[];for(let Ne=0;Ne<e.length;Ne++){let Le=e[Ne];if(!Le||Le===$L)continue;if(Le.startsWith(_Pe))H=Le;else if(K9t.has(Le))j=Le;else if(Le===EQe)he=Le;else if(Ne<s)_e.push(Le);else ke.push(Le)}let ve=[];if(H)ve.push({text:H,cacheScope:null});if(j)ve.push({text:j,cacheScope:null});if(he&&H&&j)ve.push({text:he,cacheScope:null});let xe=_e.join(`\n\n`);if(xe)ve.push({text:xe,cacheScope:"global"});let Ie=ke.join(`\n\n`);if(Ie)ve.push({text:Ie,cacheScope:"org"});return i("tengu_sysprompt_boundary_found",{blockCount:ve.length,staticBlockLength:xe.length,dynamicBlockLength:Ie.length}),ve}else i("tengu_sysprompt_missing_boundary_marker",{promptBlockCount:e.length});let g,h,y,w=[];for(let H of e){if(!H||H===$L)continue;if(H.startsWith(_Pe))g=H;else if(K9t.has(H))h=H;else if(H===EQe)y=H;else w.push(H)}let D=[];if(g)D.push({text:g,cacheScope:null});if(h)D.push({text:h,cacheScope:"org"});if(y&&g&&h)D.push({text:y,cacheScope:null});let L=w.join(`\n\n`);if(L)D.push({text:L,cacheScope:"org"});return D}';
const SDK_IDENTITY = `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`;

// Claude Code declares the identity set in a module of its own, so it is kept
// out of the scope where the split's telemetry call `i(...)` resolves.
const IDENTITY_MODULE = `var K9t=(function(){${IDENTITY};return K9t})()`;

const bundle = (...parts: string[]): string =>
  `var a={};${parts.join(';')};export{};`;
const withIdentity = (file: string, literal: string): string =>
  file.replace(SDK_IDENTITY, literal);
const stock = bundle(IDENTITY_MODULE, PREDICATE, SPLIT, CALLER);

describe('identityLiterals', () => {
  it('reads the literals of the set the split checks, in order', () => {
    expect(identityLiterals(stock)).toEqual([
      `"You are Claude Code, Anthropic's official CLI for Claude."`,
      `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`,
      SDK_IDENTITY,
    ]);
  });

  it('is null when the split is gone', () => {
    expect(
      identityLiterals(bundle(IDENTITY_MODULE, PREDICATE, CALLER))
    ).toBeNull();
  });
});

describe('writeNoGlobalCacheScope', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the bundle alone while the identity lines are stock', () => {
    expect(writeNoGlobalCacheScope(stock, stock)).toBe(stock);
  });

  it('makes the global-scope predicate answer false once an identity line is replaced', () => {
    const out = writeNoGlobalCacheScope(
      withIdentity(stock, '"You are Echo."'),
      stock
    );
    expect(out).toContain('function $Ie(){return!1}');
    expect(out).not.toContain('"anthropicAws"');
  });

  it('does the same for an identity line emptied by its override', () => {
    expect(writeNoGlobalCacheScope(withIdentity(stock, '""'), stock)).toContain(
      'function $Ie(){return!1}'
    );
  });

  it('takes the predicate from the system-prompt split, not its name', () => {
    const renamed = stock
      .replace('function $Ie(', 'function qZ9(')
      .replace('let r=$Ie()', 'let r=qZ9()')
      .replace('scope:$Ie()', 'scope:qZ9()');
    const out = writeNoGlobalCacheScope(
      withIdentity(renamed, '"You are Echo."'),
      renamed
    );
    expect(out).toContain('function qZ9(){return!1}');
  });

  it('leaves alone a same-shaped function no global marker names', () => {
    const decoy = PREDICATE.replace('function $Ie(', 'function Wd7(');
    const pristine = bundle(IDENTITY_MODULE, decoy, PREDICATE, SPLIT, CALLER);
    const out = writeNoGlobalCacheScope(
      withIdentity(pristine, '"You are Echo."'),
      pristine
    );
    expect(out).toContain(decoy);
    expect(out).toContain('function $Ie(){return!1}');
  });

  it('works when the side query has no global-scope caller', () => {
    const pristine = bundle(IDENTITY_MODULE, PREDICATE, SPLIT);
    expect(
      writeNoGlobalCacheScope(
        withIdentity(pristine, '"You are Echo."'),
        pristine
      )
    ).toContain('function $Ie(){return!1}');
  });

  it('fails loud when callers name different predicates', () => {
    const pristine = bundle(
      IDENTITY_MODULE,
      PREDICATE,
      SPLIT,
      CALLER,
      CALLER.replace('scope:$Ie()', 'scope:Vk2()')
    );
    expect(
      writeNoGlobalCacheScope(
        withIdentity(pristine, '"You are Echo."'),
        pristine
      )
    ).toBeNull();
  });

  it("fails loud when the named function no longer has the predicate's shape", () => {
    const pristine = bundle(
      IDENTITY_MODULE,
      PREDICATE.replace('"anthropicAws"', '"vertex"'),
      SPLIT,
      CALLER
    );
    expect(
      writeNoGlobalCacheScope(
        withIdentity(pristine, '"You are Echo."'),
        pristine
      )
    ).toBeNull();
  });

  it('leaves stock identities alone when the identity set cannot be found', () => {
    const pristine = bundle(IDENTITY_MODULE, PREDICATE, CALLER);
    expect(writeNoGlobalCacheScope(pristine, pristine)).toBe(pristine);
  });

  it('leaves an unrecognized pristine bundle alone without overrides', () => {
    const pristine = bundle(PREDICATE, CALLER);
    expect(writeNoGlobalCacheScope(pristine, pristine)).toBe(pristine);
    const current = `${pristine}var unrelated=1`;
    expect(writeNoGlobalCacheScope(current, pristine, false)).toBe(current);
  });

  it('leaves stock identities alone when only the current split is missing', () => {
    const current = stock.replace(
      '"tengu_sysprompt_using_tool_based_cache"',
      '"other_telemetry"'
    );
    expect(writeNoGlobalCacheScope(current, stock)).toBe(current);
  });

  it('fails when an identity changed and the split anchor is missing', () => {
    const pristine = bundle(IDENTITY_MODULE, PREDICATE, CALLER);
    expect(
      writeNoGlobalCacheScope(
        withIdentity(pristine, '"You are Echo."'),
        pristine
      )
    ).toBeNull();
  });

  it('is idempotent: a second run is a no-op', () => {
    const once = writeNoGlobalCacheScope(
      withIdentity(stock, '"You are Echo."'),
      stock
    ) as string;
    expect(writeNoGlobalCacheScope(once, stock)).toBe(once);
  });
});

describe('writeNoGlobalCacheScope: pristine identity facts', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const unrecognized = bundle(PREDICATE, CALLER);
  const noSplit = bundle(IDENTITY_MODULE, PREDICATE, CALLER);
  const cases: Array<[string, string, string, boolean | undefined]> = [
    ['stock', stock, stock, undefined],
    ['replaced', withIdentity(stock, '"You are Echo."'), stock, undefined],
    ['emptied', withIdentity(stock, '""'), stock, true],
    [
      'current split missing',
      stock.replace(
        '"tengu_sysprompt_using_tool_based_cache"',
        '"other_telemetry"'
      ),
      stock,
      undefined,
    ],
    [
      'current split missing, override applied',
      stock.replace(
        '"tengu_sysprompt_using_tool_based_cache"',
        '"other_telemetry"'
      ),
      stock,
      true,
    ],
    ['no split, stock', noSplit, noSplit, undefined],
    [
      'no split, replaced',
      withIdentity(noSplit, '"You are Echo."'),
      noSplit,
      true,
    ],
    ['unrecognized, same text', unrecognized, unrecognized, true],
    [
      'unrecognized, same text copy',
      `${unrecognized} `.trimEnd(),
      unrecognized,
      true,
    ],
    [
      'unrecognized, changed',
      `${unrecognized}var unrelated=1`,
      unrecognized,
      false,
    ],
    [
      'unrecognized, changed, override',
      `${unrecognized}var unrelated=1`,
      unrecognized,
      true,
    ],
  ];

  it.each(cases)(
    '%s: same answer as from the text',
    (_, current, pristine, override) => {
      expect(
        writeNoGlobalCacheScope(current, pristineIdentityOf(pristine), override)
      ).toBe(writeNoGlobalCacheScope(current, pristine, override));
    }
  );

  it('keeps the text only when the identity literals are not found', () => {
    expect(pristineIdentityOf(stock).text).toBeNull();
    expect(pristineIdentityOf(unrecognized).text).toBe(unrecognized);
  });
});

// The requirement, run rather than read, with Claude Code's own scope split: a
// client with a replaced identity line marks no system block global, and a
// stock one still does.
describe('writeNoGlobalCacheScope: the system prompt it produces', () => {
  const PROMPT = [
    'x-anthropic-billing-header: cc_version=2.1.280;',
    'You are Echo.',
    'static instructions',
    '__BOUNDARY__',
    'dynamic context',
  ];
  const source = [IDENTITY_MODULE, PREDICATE, SPLIT, CALLER].join(';');
  const run = (code: string) => {
    const stubs = [
      'var $L="__BOUNDARY__"',
      'var _Pe="x-anthropic-billing-header"',
      'var EQe="__EQE__"',
      'function i(){}',
      'function Ug(){return true}',
      'function ms(){return true}',
      'function Me(){return "firstParty"}',
      'function SH(){return {}}',
      'function n$(){return false}',
    ].join(';');
    return new Function(
      `${stubs};${code};return bSe(${JSON.stringify(PROMPT)})`
    )() as { text: string; cacheScope: string | null }[];
  };

  it('stock marks the static part global', () => {
    const out = writeNoGlobalCacheScope(source, source) as string;
    expect(run(out).map(b => b.cacheScope)).toContain('global');
  });

  it('a replaced identity marks nothing global and still caches the prompt', () => {
    const blocks = run(
      writeNoGlobalCacheScope(
        withIdentity(source, '"You are Echo."'),
        source
      ) as string
    );
    expect(blocks.map(b => b.cacheScope)).not.toContain('global');
    expect(blocks.some(b => b.cacheScope === 'org')).toBe(true);
    expect(blocks.map(b => b.text).join('\n')).toContain('static instructions');
  });
});
