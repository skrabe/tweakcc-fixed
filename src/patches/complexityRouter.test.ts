import { describe, expect, it, beforeEach } from 'vitest';
import { writeComplexityRouter } from './complexityRouter';
import { ComplexityRouterConfig } from '../types';

// Faithful CC 2.1.186 (darwin) minified shapes the patch anchors on.
const XQ_SHAPE =
  'function XQ(e,t){if(!FR(e))return;let n=fUe(e),r=Tbn(e),o=mUe();' +
  'if(o===null)return n?r:void 0;let s=o??(n?r:void 0)??t??r;' +
  'if(s==="max"&&!dUe(e))return"high";if(s==="xhigh"&&!GRe(e))return"high";return s}';

// hMm submit handler (trimmed): the throw-guard is the stable hook anchor.
const HMM_SHAPE =
  'async function hMm(e,t,n,r){let E=null,k=e;if(typeof e==="string")E=e;' +
  'if(E===null&&t!=="prompt")throw Error(`Mode: ${t} requires a string input.`);' +
  'return cZn(aVl(E,k),[])}';

// gB pins model:HR() - the cheap one-shot structured classifier we want.
const GB_SHAPE =
  'async function gB({systemPrompt:e=vc([]),userPrompt:t,outputFormat:n,signal:r,options:o}){' +
  'return(await qWn([Ln({content:e.map((i)=>({type:"text",text:i}))}),Ln({content:t})],async()=>{' +
  'let i=[Ln({content:t})];return[await DWe({messages:i,systemPrompt:e,thinkingConfig:{type:"disabled"},' +
  'tools:[],signal:r,options:{...o,stickyBetas:o.stickyBetas??o0(WH()),agentContext:o.agentContext,' +
  'model:HR(),enablePromptCaching:o.enablePromptCaching??!1,outputFormat:n,' +
  'async getToolPermissionContext(){return WM()}}})]}))[0]}';

// Vpt is gB's twin - same signature, but NO pinned model (uses the caller's).
const VPT_SHAPE =
  'async function Vpt({systemPrompt:e=vc([]),userPrompt:t,outputFormat:n,signal:r,options:o}){' +
  'return(await qWn([Ln({content:e.map((i)=>({type:"text",text:i}))}),Ln({content:t})],async()=>{' +
  'let i=[Ln({content:t})];return[await DWe({messages:i,systemPrompt:e,thinkingConfig:{type:"disabled"},' +
  'tools:[],signal:r,options:{...o,stickyBetas:o.stickyBetas??o0(WH()),agentContext:o.agentContext,' +
  'enablePromptCaching:o.enablePromptCaching??!1,outputFormat:n,' +
  'async getToolPermissionContext(){return WM()}}})]}))[0]}';

// km agent-context builder (required by the llm classifier).
const KM_SHAPE = 'function km(){return{agentType:"main",agentId:xt()}}';

const FILE = `var head=1;${GB_SHAPE}${VPT_SHAPE}${KM_SHAPE}${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;

const cfg = (
  over: Partial<ComplexityRouterConfig> = {}
): ComplexityRouterConfig => ({
  enabled: true,
  mode: 'heuristic',
  pinPerTask: true,
  levels: [
    { id: 'routine', label: 'Routine', help: '', effort: 'low' },
    { id: 'standard', label: 'Standard', help: '', effort: 'medium' },
    { id: 'hard', label: 'Hard', help: '', effort: 'high' },
    { id: 'frontier', label: 'Frontier', help: '', effort: 'max' },
  ],
  ...over,
});

// Run a generated async function body's syntax through the parser without
// executing it (free identifiers like gB/FR resolve at call time, not parse).
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const assertParses = (src: string) => {
  expect(() => new AsyncFunction(src)).not.toThrow();
};

// Pull the generated heuristic scorer out and make it callable so we test the
// REAL injected logic (not a TS re-implementation).
const extractScorer = (
  patched: string
): ((t: string, max: number) => number) => {
  const m = patched.match(/function __tweakccRouterScore[\s\S]*?return __l\}/);
  if (!m) throw new Error('scorer not found in patched output');
  return new Function(m[0] + ';return __tweakccRouterScore;')() as (
    t: string,
    max: number
  ) => number;
};

// Extract the whole heuristic runtime (state + scorer + classify) and return a
// callable classify(text, mode) that reads/writes globalThis.__tweakccRouter.
const extractClassify = (
  patched: string
): ((text: string, mode: string) => Promise<void>) => {
  const m = patched.match(
    /function __tweakccRouterState[\s\S]*?(?=function XQ\()/
  );
  if (!m) throw new Error('runtime not found in patched output');
  return new Function(m[0] + ';return __tweakccRouterClassify;')() as (
    text: string,
    mode: string
  ) => Promise<void>;
};

const routerState = () =>
  (
    globalThis as unknown as Record<
      string,
      { level?: number; effort?: string; baseline?: string | null }
    >
  ).__tweakccRouter;

// Extract the runtime + the WRAPPED resolver and make XQ callable with stubbed
// CC helpers, so we exercise the REAL precedence logic (env / baseline / guards).
const extractWrappedResolver = (
  patched: string,
  overrides: Record<string, (...a: unknown[]) => unknown> = {}
): ((e: string, t: unknown) => unknown) => {
  const m = patched.match(
    /function __tweakccRouterState[\s\S]*?function XQ\([\s\S]*?return s\}/
  );
  if (!m) throw new Error('wrapped resolver not found in patched output');
  const stubs: Record<string, (...a: unknown[]) => unknown> = {
    FR: () => true, // supports effort
    fUe: () => true, // launch-pin flag
    Tbn: () => 'YIELDED', // per-model default = sentinel for "fell through"
    mUe: () => null, // CLAUDE_CODE_EFFORT_LEVEL unset
    dUe: () => true, // supports max
    GRe: () => true, // supports xhigh
    ...overrides,
  };
  const names = ['FR', 'fUe', 'Tbn', 'mUe', 'dUe', 'GRe'];
  return new Function(...names, m[0] + ';return XQ;')(
    ...names.map(n => stubs[n])
  ) as (e: string, t: unknown) => unknown;
};

const setRouterState = (s: {
  level?: number;
  effort?: string;
  baseline?: string | null;
}) => {
  (globalThis as unknown as Record<string, unknown>).__tweakccRouter = s;
};

describe('writeComplexityRouter', () => {
  it('wraps the effort resolver and hooks the submit handler (heuristic)', () => {
    const out = writeComplexityRouter(FILE, cfg());
    expect(out).not.toBeNull();
    const r = out as string;
    expect(r).toContain('function __tweakccRouterClassify');
    expect(r).toContain('function __tweakccRouterScore');
    expect(r).toContain('var __st=__tweakccRouterState();');
    expect(r).toContain('let __twkRE=__st.effort;');
    expect(r).toContain('if(__twkRE&&o==null&&(t==null||t===__st.baseline))');
    expect(r).toContain('!dUe(e)');
    expect(r).toContain('!GRe(e)');
    expect(r).toContain('await __tweakccRouterClassify(E,t);');
    expect(r).toContain('var head=1;');
    expect(r).toContain('var tail=2;');
    expect(r).not.toContain('__tweakccRouterClassifyLlm');
  });

  it('produces syntactically valid injected JS', () => {
    assertParses(writeComplexityRouter(FILE, cfg()) as string);
    assertParses(writeComplexityRouter(FILE, cfg({ mode: 'llm' })) as string);
  });

  it('is idempotent', () => {
    const once = writeComplexityRouter(FILE, cfg()) as string;
    expect(writeComplexityRouter(once, cfg())).toBe(once);
  });

  it('introduces no non-ASCII codepoints (mojibake guard)', () => {
    const out = writeComplexityRouter(FILE, cfg({ mode: 'llm' })) as string;
    const maxCp = out
      .split('')
      .reduce((m, ch) => Math.max(m, ch.charCodeAt(0)), 0);
    expect(maxCp).toBeLessThanOrEqual(0x7f);
  });

  it('emits the llm classifier targeting gB with the full options shape', () => {
    const out = writeComplexityRouter(FILE, cfg({ mode: 'llm' })) as string;
    expect(out).toContain('__tweakccRouterClassifyLlm');
    expect(out).toContain('await gB({systemPrompt:[__sys]');
    // H1: agentContext is REQUIRED or gB throws on every call.
    expect(out).toContain('agentContext:km()');
    expect(out).toContain('querySource:"route_complexity"');
    expect(out).not.toContain('await Vpt(');
  });

  it('falls back to heuristic when llm mode finds no gB/km helpers', () => {
    const noGb = `var head=1;${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;
    const out = writeComplexityRouter(noGb, cfg({ mode: 'llm' })) as string;
    expect(out).not.toBeNull();
    expect(out).toContain('function __tweakccRouterClassify');
    expect(out).not.toContain('__tweakccRouterClassifyLlm');
  });

  it('no-ops gracefully when the effort resolver is absent', () => {
    const file = 'var x=1;function y(){return 2}';
    expect(writeComplexityRouter(file, cfg())).toBe(file);
  });

  it('fails (null) when effort machinery is present but the shape drifted', () => {
    const drifted =
      'var x="CLAUDE_CODE_EFFORT_LEVEL";function z(){return"high"}';
    expect(writeComplexityRouter(drifted, cfg())).toBeNull();
  });

  it('reverts the whole patch (no half-patch) when the submit handler is absent', () => {
    // XQ present but the submit-throw anchor absent: must NOT ship the wrap +
    // runtime with no classify call to populate the global (all-or-nothing).
    const noSubmit = `var head=1;${XQ_SHAPE}var tail=2;`;
    expect(noSubmit.includes('requires a string input.')).toBe(false);
    expect(writeComplexityRouter(noSubmit, cfg())).toBe(noSubmit);
  });

  describe('heuristic scorer (real injected logic)', () => {
    const score = extractScorer(writeComplexityRouter(FILE, cfg()) as string);

    it('routes confidently-trivial work down to Routine (level 0)', () => {
      expect(score('rename this variable to userCount', 3)).toBe(0);
      expect(score('fix the typo in the readme', 3)).toBe(0);
      expect(score('add a comment to this function', 3)).toBe(0);
      expect(score('bump the version to 2.0.1', 3)).toBe(0);
    });

    it('keeps genuinely-ambiguous work at the Standard default (level 1)', () => {
      expect(score('update the user profile page', 3)).toBe(1);
      expect(score('change the button color to blue', 3)).toBe(1);
    });

    it('does not route to low once any hard signal is present', () => {
      // a trivial verb + a hard signal must NOT drop to low
      expect(score('rename things while fixing the race condition', 3)).toBe(2);
    });

    it('escalates one strong signal to Hard (level 2)', () => {
      expect(score('fix the race condition in the worker pool', 3)).toBe(2);
      expect(score('refactor the auth module across files', 3)).toBe(2);
      expect(
        score('there is a security vulnerability in the login flow', 3)
      ).toBe(2);
    });

    it('jumps to the top tier on explicit max-escalation phrases', () => {
      expect(score('ultrathink about this and solve it', 3)).toBe(3);
    });

    it('reaches the top tier on heavy signal accumulation', () => {
      const heavy =
        'we have a race condition and a security vulnerability; refactor ' +
        'across modules and fix the deadlock. why is it flaky? optimize the ' +
        'algorithm too. this is production critical.';
      expect(score(heavy, 3)).toBe(3);
    });

    it('keeps empty/contentless input at the Standard default (no trivial verb)', () => {
      expect(score('', 3)).toBe(1);
      expect(score('hi', 3)).toBe(1);
    });

    it('clamps to the configured max level', () => {
      expect(score('ultrathink hard about everything', 2)).toBe(2);
    });

    it('stays fast (linear) on long single-line pastes (ReDoS guard)', () => {
      // Pre-fix these froze the TUI for 1-3.5s; the input cap + bounded
      // quantifiers keep it well under a frame.
      for (const big of [
        'a'.repeat(60000) + 'exception:', // [\w.$]+(error|exception): prefix
        'a'.repeat(60000), // plain run
        'https://example.com/' + 'a'.repeat(60000), // long single token
        'a.'.repeat(40000), // path-count [\w./-]+\.[a-z]{1,5}
        'at x(' + '1'.repeat(60000), // stack-trace \d+:\d+ near-miss
        '('.repeat(60000), // many open parens
      ]) {
        const t0 = performance.now();
        const lvl = score(big, 3);
        expect(performance.now() - t0).toBeLessThan(100);
        expect(lvl).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('classify entry point (real injected logic)', () => {
    beforeEach(() => {
      delete (globalThis as unknown as Record<string, unknown>).__tweakccRouter;
    });

    it('writes the level effort and escalates monotonically when pinned', async () => {
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string
      );
      await classify('rename the variable', 'prompt'); // trivial -> low
      expect(routerState().effort).toBe('low');
      await classify('fix the race condition', 'prompt'); // level 2 -> high
      expect(routerState().effort).toBe('high');
      await classify('just rename this thing', 'prompt'); // trivial, pinned -> stays high
      expect(routerState().effort).toBe('high');
    });

    it('re-rates up AND down when pinPerTask is off', async () => {
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ pinPerTask: false })) as string
      );
      await classify('fix the race condition', 'prompt'); // high
      expect(routerState().effort).toBe('high');
      await classify('rename this thing', 'prompt'); // trivial -> low (down allowed)
      expect(routerState().effort).toBe('low');
    });

    it('resets the pin on /clear (incl. trailing whitespace)', async () => {
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string
      );
      await classify('fix the race condition', 'prompt');
      await classify('/clear\n', 'prompt');
      expect(routerState().level).toBeUndefined();
    });

    it('ignores other slash commands and non-prompt modes', async () => {
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string
      );
      await classify('/theme', 'prompt');
      await classify('ls -la', 'bash');
      expect(routerState().effort).toBeUndefined();
    });

    it('drops the captured baseline on /clear so the router resumes', async () => {
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string
      );
      await classify('fix the race condition', 'prompt');
      routerState().baseline = 'xhigh'; // simulate the wrap having captured it
      await classify('/clear\n', 'prompt');
      expect(routerState().level).toBeUndefined();
      expect(routerState().effort).toBeUndefined();
      expect(routerState().baseline).toBeUndefined(); // re-captured fresh next resolve
    });
  });

  describe('effort-resolver wrap precedence (real injected logic)', () => {
    beforeEach(() => {
      delete (globalThis as unknown as Record<string, unknown>).__tweakccRouter;
    });

    const patched = () => writeComplexityRouter(FILE, cfg()) as string;

    it('OVERRIDES a persisted effort baseline (the inert-router bug)', () => {
      // User has settings.effortLevel=xhigh -> arrives as the app-state fallback.
      // The router must win over it (deferring would make the router silently inert).
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched());
      expect(XQ('m', 'xhigh')).toBe('medium'); // baseline<-xhigh; t===baseline -> router drives
      expect(XQ('m', 'xhigh')).toBe('medium'); // stays driven across turns
    });

    it('YIELDS to an in-session /effort (fallback diverges from the launch baseline)', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched());
      expect(XQ('m', 'xhigh')).toBe('medium'); // launch baseline captured = xhigh
      expect(XQ('m', 'low')).toBe('YIELDED'); // user /effort'd to low -> router steps aside
    });

    it('YIELDS to the CLAUDE_CODE_EFFORT_LEVEL env pin', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      // env set -> o!=null -> wrap never fires; CC's own resolution returns it.
      const XQ = extractWrappedResolver(patched(), { mUe: () => 'high' });
      expect(XQ('m', 'xhigh')).toBe('high');
    });

    it('drives when nothing is pinned (baseline null) and re-applies support guards', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched());
      expect(XQ('m', undefined)).toBe('medium'); // t unset -> baseline null -> router drives
      // unsupported routed level downgrades to "high"
      setRouterState({ level: 3, effort: 'max', baseline: undefined });
      const XQ2 = extractWrappedResolver(patched(), { dUe: () => false });
      expect(XQ2('m', undefined)).toBe('high');
    });

    it('end-to-end: real classify sets the effort, the real wrap overrides a persisted baseline', async () => {
      // Faithful full path: classify (writes the global) -> wrapped resolver
      // (reads it) with a non-null fallback standing in for settings.effortLevel.
      // This is the exact runtime flow the original unit tests did NOT model.
      const p = patched();
      const classify = extractClassify(p);
      const XQ = extractWrappedResolver(p); // shares globalThis.__tweakccRouter
      await classify('rename the variable', 'prompt'); // trivial -> low
      expect(XQ('m', 'xhigh')).toBe('low'); // persisted xhigh overridden, routed all the way down
    });

    it('captures the launch baseline on the first resolve while the router is still inactive (boot ordering)', async () => {
      // Production order: eZ resolves (a pre-submit poll) and captures the
      // baseline BEFORE any classify sets an effort - the inverse of the
      // seed-effort-first shape the other precedence tests use.
      const p = patched();
      const XQ = extractWrappedResolver(p);
      const classify = extractClassify(p); // shares globalThis.__tweakccRouter
      // 1) router inactive (no effort yet): the first resolve captures baseline
      expect(XQ('m', 'xhigh')).toBe('YIELDED'); // no router effort -> CC's own resolution
      expect(routerState().baseline).toBe('xhigh');
      // 2) a routine task classifies -> low
      await classify('rename the variable', 'prompt');
      expect(routerState().effort).toBe('low');
      // 3) resolve again: fallback still == baseline -> the router now drives
      expect(XQ('m', 'xhigh')).toBe('low');
    });
  });

  describe('llm classifier (real injected logic, H1 regression)', () => {
    // Extract the emitted llm classifier + result parser and run it against a
    // stub gB/km so we PROVE it passes agentContext and parses the level.
    const buildLlm = () => {
      const patched = writeComplexityRouter(
        FILE,
        cfg({ mode: 'llm' })
      ) as string;
      const m = patched.match(
        /async function __tweakccRouterClassifyLlm[\s\S]*?(?=async function __tweakccRouterClassify\()/
      );
      if (!m) throw new Error('llm classifier not found');
      let captured: { options?: Record<string, unknown> } = {};
      const stubGB = async (opts: { options?: Record<string, unknown> }) => {
        captured = opts;
        return {
          message: { content: [{ type: 'text', text: '{"level":2}' }] },
        };
      };
      const km = () => ({ agentType: 'main', agentId: 'x' });
      const fn = new Function(
        'gB',
        'km',
        'AbortController',
        'setTimeout',
        'clearTimeout',
        m[0] + ';return __tweakccRouterClassifyLlm;'
      )(stubGB, km, AbortController, setTimeout, clearTimeout) as (
        t: string,
        max: number
      ) => Promise<number | null>;
      return { fn, getCaptured: () => captured };
    };

    it('passes a valid agentContext (would TypeError without it) and parses the level', async () => {
      const { fn, getCaptured } = buildLlm();
      const level = await fn('refactor the whole auth subsystem', 3);
      expect(level).toBe(2);
      const opts = getCaptured().options as Record<string, unknown>;
      expect(opts.agentContext).toEqual({ agentType: 'main', agentId: 'x' });
      expect(opts.querySource).toBe('route_complexity');
      expect(opts.agents).toEqual([]);
    });
  });
});
