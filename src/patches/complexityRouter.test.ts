import { describe, expect, it, beforeEach } from 'vitest';
import { writeComplexityRouter } from './complexityRouter';
import { clearRequireFuncNameCache } from './helpers';
import { ComplexityRouterConfig } from '../types';

// Faithful CC 2.1.186 (darwin) minified shapes the patch anchors on.
const XQ_SHAPE =
  'function XQ(e,t){if(!FR(e))return;let n=fUe(e),r=Tbn(e),o=mUe();' +
  'if(o===null)return n?r:void 0;let s=o??(n?r:void 0)??t??r;' +
  'if(s==="max"&&!dUe(e))return"high";if(s==="xhigh"&&!GRe(e))return"high";return s}';

// hMm submit handler (trimmed): the throw-guard is the stable hook anchor.
const HMM_SHAPE =
  'async function hMm(e,t,n,r){let E=null,k=Sg(r.options.mainLoopModel),w=e;if(typeof e==="string")E=e;' +
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

// km agent-context builder (required by the classifier).
const KM_SHAPE = 'function km(){return{agentType:"main",agentId:xt()}}';

// CC's conversation-compaction return (the splice-4 anchor): summaryText is the
// compaction summary we reseed from.
const COMPACT_SHAPE =
  'function doCompact(){return{ok:!0,summaryText:Sx,forkAssistantMessageCount:0,totalUsage:U,messages:[Mn({content:T1t(Sx,!0,c),isCompactSummary:!0})]}}';

// CC's tool-use-summary site where the last assistant text is extracted (the
// optional prev-assistant capture anchor).
const ZE_SHAPE =
  'let Qn;if(g.gates.emitToolUseSummaries&&ye.length>0){' +
  'let Et=Te.at(-1),Ze;if(Et){let Un=Et.message.content.filter((Tt)=>Tt.type==="text");' +
  'if(Un.length>0){let Tt=Un.at(-1);if(Tt&&"text"in Tt)Ze=Tt.text}}}';

// CC's global session-id accessor (the optional persistence anchor).
const SID_SHAPE = 'getSessionId(){return It()}';

// CC's rewind dialog wiring (the splice-5 anchor): "Restore conversation" calls
// onRestoreMessage with the "message_selector" source.
const RESTORE_SHAPE =
  'function P9o(p){return me(Sb,{onRestoreMessage:(ut)=>Dlr(ut,"message_selector"),onSummarize:()=>0})}';

const FILE = `var head=1;${GB_SHAPE}${VPT_SHAPE}${KM_SHAPE}${ZE_SHAPE}${COMPACT_SHAPE}${RESTORE_SHAPE}${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;

const cfg = (
  over: Partial<ComplexityRouterConfig> = {}
): ComplexityRouterConfig => ({
  enabled: true,
  pinPerTask: true,
  messageCap: 50000,
  assistantCap: 50000,
  timeoutMs: 15000,
  systemPrompt: 'You route. Levels:\n{LEVELS}\nTop is {MAX}.',
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

type RouterState = {
  level?: number;
  effort?: string;
  baseline?: string | null;
  summary?: string;
  prevUser?: string;
  prevAssistant?: string;
  pendingCompaction?: string;
  pendingRewindCut?: string | number;
  log?: { ts: number; summary: string; level?: number }[];
  model?: string;
  loaded?: boolean;
};

// A stub gB: queue of {level,summary} results (or the string 'throw'). Captures
// every options arg so we can assert the assembled userPrompt / agentContext.
type GbOpts = { userPrompt?: string; options?: Record<string, unknown> };
type GbFn = (opts: GbOpts) => Promise<unknown>;
type GbResult = { level?: number; summary?: string } | 'throw';
const makeGB = (results: GbResult[]) => {
  const captured: { userPrompt?: string; options?: Record<string, unknown> }[] =
    [];
  let i = 0;
  const gb = async (opts: {
    userPrompt?: string;
    options?: Record<string, unknown>;
  }) => {
    captured.push(opts);
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (r === 'throw') throw new Error('boom');
    return {
      message: { content: [{ type: 'text', text: JSON.stringify(r) }] },
    };
  };
  return { gb, captured };
};

// Extract the whole runtime (state + helpers + classify) and return a callable
// classify(text, mode, model?) wired to a stub gB/km, reading/writing globalThis.
const extractClassify = (
  patched: string,
  gb: GbFn
): ((text: string, mode: string, model?: string) => Promise<void>) => {
  const m = patched.match(
    /function __tweakccRouterState[\s\S]*?(?=function XQ\()/
  );
  if (!m) throw new Error('runtime not found in patched output');
  const km = () => ({ agentType: 'main', agentId: 'x' });
  return new Function('gB', 'km', m[0] + ';return __tweakccRouterClassify;')(
    gb,
    km
  ) as (text: string, mode: string, model?: string) => Promise<void>;
};

const routerState = () =>
  (globalThis as unknown as Record<string, RouterState>).__tweakccRouter;
const setRouterState = (s: RouterState) => {
  (globalThis as unknown as Record<string, unknown>).__tweakccRouter = s;
};

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

describe('writeComplexityRouter', () => {
  it('wraps the resolver, hooks the submit handler, and emits the Haiku classifier', () => {
    const out = writeComplexityRouter(FILE, cfg());
    expect(out).not.toBeNull();
    const r = out as string;
    expect(r).toContain('function __tweakccRouterClassify');
    expect(r).toContain('async function __tweakccRouterClassifyLlm');
    expect(r).toContain('var __st=__tweakccRouterState();');
    expect(r).toContain('let __twkRE=__st.effort;');
    expect(r).toContain('if(__twkRE&&o==null&&(t==null||t===__st.baseline))');
    // The submit hook threads the in-use model (captured from r.options
    // .mainLoopModel above the throw) into the classifier for the <context> block.
    expect(r).toContain(
      'await __tweakccRouterClassify(E,t,r.options.mainLoopModel);'
    );
    expect(r).toContain('var head=1;');
    expect(r).toContain('var tail=2;');
    // The heuristic scorer is gone entirely.
    expect(r).not.toContain('__tweakccRouterScore');
  });

  it('substitutes {LEVELS}/{MAX} into the editable system prompt and emits a <context> block (model + prev level)', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    // template substitution: {MAX} -> top index (3), {LEVELS} -> the rubric
    expect(out).toContain('Top is 3.');
    expect(out).toContain('Level 0 (Routine)');
    expect(out).toContain('Level 3 (Frontier)');
    expect(out).not.toContain('{LEVELS}');
    expect(out).not.toContain('{MAX}');
    // the classifier entry takes a model arg and builds the <context> block
    expect(out).toContain(
      'async function __tweakccRouterClassify(__text,__mode,__model)'
    );
    expect(out).toContain('<context>');
    expect(out).toContain('model in use: ');
    expect(out).toContain('level you assigned last turn: ');
    // model is captured into state for next-turn change detection
    expect(out).toContain('__st.model=__model;');
  });

  it('falls back to the default system prompt when the config template is blank', () => {
    const out = writeComplexityRouter(
      FILE,
      cfg({ systemPrompt: '   ' })
    ) as string;
    // the shipped default opens with this line
    expect(out).toContain(
      'You are a difficulty router for an AI coding agent.'
    );
  });

  it('captures the previous assistant text at the tool-summary site', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    expect(out).toContain('__twr.prevAssistant=Ze');
  });

  it('captures CC compaction summary via the comma-operator splice', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    expect(out).toContain('globalThis.__tweakccRouter.pendingCompaction=Sx');
    expect(out).toContain('return globalThis.__tweakccRouter&&'); // comma-op; returned object untouched
    expect(out).toContain('summaryText:Sx,'); // original return shape preserved
  });

  it('captures the rewind target timestamp on the Restore handler (splice 5)', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    // comma-op tag of m.timestamp; the original onRestoreMessage call is untouched
    expect(out).toContain(
      'globalThis.__tweakccRouter.pendingRewindCut=ut&&ut.timestamp'
    );
    expect(out).toContain('Dlr(ut,"message_selector")');
    expect(out).toContain('__st.pendingRewindCut'); // reconcile consumes it
    expect(out).toContain('__st.log.push({ts:'); // per-turn snapshot record
    // absent restore site -> no capture emitted, still patches fine
    const noRestore = `var head=1;${GB_SHAPE}${KM_SHAPE}${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;
    const out2 = writeComplexityRouter(noRestore, cfg()) as string;
    expect(out2).not.toContain('pendingRewindCut=ut&&');
  });

  it('still patches when the prev-assistant capture site is absent', () => {
    const noZe = `var head=1;${GB_SHAPE}${KM_SHAPE}${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;
    const out = writeComplexityRouter(noZe, cfg()) as string;
    expect(out).not.toBeNull();
    expect(out).toContain('function __tweakccRouterClassify');
    expect(out).not.toContain('prevAssistant=Ze');
  });

  it('wires session-id persistence when the accessor is present', () => {
    const withSid = `var head=1;${GB_SHAPE}${KM_SHAPE}class C{${SID_SHAPE}}${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;
    const out = writeComplexityRouter(withSid, cfg()) as string;
    expect(out).toContain('return typeof __s==="string"&&__s?__s:null}'); // sid()
    expect(out).toContain('var __s=It()'); // discovered accessor wired in
    expect(out).toContain('function __tweakccRouterSave');
    // the rewind-snapshot log is persisted (save) and reloaded (load) too, so
    // resume->rewind cuts precisely; the write is async fire-and-forget.
    expect(out).toContain('log:Array.isArray(__st.log)?__st.log:[]'); // saved
    expect(out).toContain('if(Array.isArray(__d.log))__st.log=__d.log'); // loaded
    expect(out).toContain('__fs.writeFile('); // async, not writeFileSync
    expect(out).not.toContain('writeFileSync');
  });

  it('disables persistence (sid=null) when no accessor is found', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    expect(out).toContain('var __s=null;'); // sidExpr === 'null'
  });

  it('threads the esbuild require fn into the sidecar fs/path/os (not bare require)', () => {
    // On NPM/esbuild builds `require` is not global - it's a createRequire-derived
    // var. The sidecar must use the resolved name or fs calls throw (persistence
    // silently dies). getRequireFuncName caches, so clear around this case.
    clearRequireFuncNameCache();
    try {
      const esbuildFile = `import{createRequire as Qx}from"node:module";var Rq=Qx(import.meta.url);${FILE}`;
      const out = writeComplexityRouter(esbuildFile, cfg()) as string;
      expect(out).toContain('Rq("fs")'); // resolved esbuild require var
      expect(out).toContain('Rq("path")');
      expect(out).toContain('Rq("os")');
      expect(out).not.toContain('require("fs")'); // no bare require survived
    } finally {
      clearRequireFuncNameCache(); // don't leak "Rq" into the Bun-shaped cases
    }
  });

  it('produces syntactically valid injected JS', () => {
    assertParses(writeComplexityRouter(FILE, cfg()) as string);
    assertParses(
      writeComplexityRouter(FILE, cfg({ pinPerTask: false })) as string
    );
  });

  it('is idempotent', () => {
    const once = writeComplexityRouter(FILE, cfg()) as string;
    expect(writeComplexityRouter(once, cfg())).toBe(once);
  });

  it('introduces no non-ASCII codepoints (mojibake guard)', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    const maxCp = out
      .split('')
      .reduce((m, ch) => Math.max(m, ch.charCodeAt(0)), 0);
    expect(maxCp).toBeLessThanOrEqual(0x7f);
  });

  it('emits the classifier targeting gB with the full options shape (H1)', () => {
    const out = writeComplexityRouter(FILE, cfg()) as string;
    expect(out).toContain('await gB({systemPrompt:[__sys]');
    // agentContext is REQUIRED or gB throws on every call.
    expect(out).toContain('agentContext:km()');
    expect(out).toContain('querySource:"route_complexity"');
    expect(out).not.toContain('await Vpt(');
  });

  it('no-ops when the Haiku helpers (gB/km) are absent (Haiku-only, no fallback)', () => {
    const noGb = `var head=1;${XQ_SHAPE}${HMM_SHAPE}var tail=2;`;
    expect(writeComplexityRouter(noGb, cfg())).toBe(noGb);
  });

  it('no-ops gracefully when the effort resolver is absent', () => {
    const file = `var x=1;${GB_SHAPE}${KM_SHAPE}function y(){return 2}`;
    expect(writeComplexityRouter(file, cfg())).toBe(file);
  });

  it('fails (null) when effort machinery is present but the shape drifted', () => {
    const drifted = `var x="CLAUDE_CODE_EFFORT_LEVEL";${GB_SHAPE}${KM_SHAPE}function z(){return"high"}`;
    expect(writeComplexityRouter(drifted, cfg())).toBeNull();
  });

  it('reverts the whole patch (no half-patch) when the submit handler is absent', () => {
    // gB/km + XQ present but the submit-throw anchor absent: must NOT ship the
    // wrap + runtime with no classify call to populate the global.
    const noSubmit = `var head=1;${GB_SHAPE}${KM_SHAPE}${XQ_SHAPE}var tail=2;`;
    expect(noSubmit.includes('requires a string input.')).toBe(false);
    expect(writeComplexityRouter(noSubmit, cfg())).toBe(noSubmit);
  });

  describe('classify entry point (real injected logic, stubbed Haiku)', () => {
    beforeEach(() => {
      delete (globalThis as unknown as Record<string, unknown>).__tweakccRouter;
    });

    it('applies the level the classifier returns', async () => {
      const { gb } = makeGB([{ level: 0, summary: 's' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('rename the variable', 'prompt');
      expect(routerState().effort).toBe('low');
    });

    it('escalates monotonically when pinned (never drops)', async () => {
      const { gb } = makeGB([
        { level: 2, summary: 's' }, // high
        { level: 0, summary: 's' }, // trivial, but pinned -> stays high
      ]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('fix the race condition', 'prompt');
      expect(routerState().effort).toBe('high');
      await classify('just rename this', 'prompt');
      expect(routerState().effort).toBe('high');
    });

    it('tracks up AND down when pinPerTask is off', async () => {
      const { gb } = makeGB([
        { level: 2, summary: 's' },
        { level: 0, summary: 's' },
      ]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ pinPerTask: false })) as string,
        gb
      );
      await classify('fix the race condition', 'prompt');
      expect(routerState().effort).toBe('high');
      await classify('rename this thing', 'prompt');
      expect(routerState().effort).toBe('low'); // down allowed
    });

    it('feeds the model into <context> and detects a mid-session model switch', async () => {
      const { gb, captured } = makeGB([
        { level: 1, summary: 's1' },
        { level: 1, summary: 's2' },
      ]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('first task', 'prompt', 'claude-opus-4-8');
      // turn 1: model reported, no switch (no prior model), state records it
      expect(captured[0].userPrompt).toContain('model in use: claude-opus-4-8');
      expect(captured[0].userPrompt).not.toContain('switched from');
      expect(routerState().model).toBe('claude-opus-4-8');
      // turn 2 on a different model: <context> flags the switch + prev level
      await classify('next task', 'prompt', 'claude-sonnet-4-6');
      expect(captured[1].userPrompt).toContain(
        'model in use: claude-sonnet-4-6'
      );
      expect(captured[1].userPrompt).toContain('switched from claude-opus-4-8');
      expect(captured[1].userPrompt).toContain(
        'level you assigned last turn: 1'
      );
    });

    it('folds the rolling summary forward into the next call', async () => {
      const { gb, captured } = makeGB([
        { level: 1, summary: 'SUMMARY-ONE' },
        { level: 1, summary: 'SUMMARY-TWO' },
      ]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('first task here', 'prompt');
      expect(routerState().summary).toBe('SUMMARY-ONE');
      await classify('second task here', 'prompt');
      // The prior summary + prev user message + new message are fed back.
      expect(captured[1].userPrompt).toContain('SUMMARY-ONE');
      expect(captured[1].userPrompt).toContain('first task here'); // prevUser
      expect(captured[1].userPrompt).toContain('second task here'); // new message
      expect(routerState().summary).toBe('SUMMARY-TWO');
    });

    it('does NOT cap the stored summary length (TL;DR by prompt, not truncation)', async () => {
      const { gb } = makeGB([{ level: 1, summary: 'y'.repeat(5000) }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('a task', 'prompt');
      expect((routerState().summary as string).length).toBe(5000);
    });

    it('middle-truncates an over-cap prev assistant turn (head+tail kept, no mechanical floor)', async () => {
      const { gb, captured } = makeGB([{ level: 0, summary: 's' }]); // classifier says trivial
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ assistantCap: 4000 })) as string,
        gb
      );
      setRouterState({ prevAssistant: 'A'.repeat(3000) + 'B'.repeat(3000) }); // 6000 > 4000
      await classify('continue', 'prompt');
      const input = captured[0].userPrompt as string;
      expect(routerState().effort).toBe('low'); // the classifier's level, NOT floored
      expect(input).toContain('omitted from the middle'); // size marker
      expect(input).toContain('A'.repeat(100)); // head kept
      expect(input).toContain('B'.repeat(100)); // tail kept
      expect(input.includes('A'.repeat(2500))).toBe(false); // head capped at cap/2 (2000)
    });

    it('middle-truncates an over-cap new message (keeps the ask at the tail)', async () => {
      const { gb, captured } = makeGB([{ level: 1, summary: 's' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ messageCap: 4000 })) as string,
        gb
      );
      const msg = 'HEAD-INTENT ' + 'x'.repeat(6000) + ' TAIL-ASK';
      await classify(msg, 'prompt');
      const input = captured[0].userPrompt as string;
      expect(input).toContain('HEAD-INTENT'); // framing kept
      expect(input).toContain('TAIL-ASK'); // the actual ask survives (head-only would lose it)
      expect(input).toContain('omitted from the middle');
    });

    it('reseeds the summary from a pending compaction summary, then clears it', async () => {
      const { gb, captured } = makeGB([{ level: 1, summary: 'fresh tldr' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      setRouterState({
        pendingCompaction: 'COMPACTED-SUMMARY-XYZ',
        level: 3,
        summary: 'old',
        prevAssistant: 'old-assistant-text',
      });
      await classify('keep going', 'prompt');
      expect(captured[0].userPrompt).toContain('COMPACTED-SUMMARY-XYZ'); // reseeded into <summary>
      expect(captured[0].userPrompt).not.toContain('old-assistant-text'); // stale exchange dropped
      expect(routerState().pendingCompaction).toBeUndefined(); // consumed
      expect(routerState().summary).toBe('fresh tldr'); // Haiku re-compressed it
    });

    it('CUTS to the logged turn at the rewind target time (restore + truncate tail)', async () => {
      const { gb, captured } = makeGB([{ level: 0, summary: 'after redo' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ pinPerTask: false })) as string,
        gb
      );
      // a 3-turn log; the rewind target's time (2500) sits between turn 2 (ts 2000)
      // and turn 3 (ts 3000), so the cut restores turn-2's state (S2) and drops 3+.
      setRouterState({
        pendingRewindCut: 2500, // numeric ms, compared against the logged ts
        summary: 'S3 stale rewound-away work',
        level: 3,
        prevAssistant: 'old',
        log: [
          { ts: 1000, summary: 'S1', level: 1 },
          { ts: 2000, summary: 'S2', level: 2 },
          { ts: 3000, summary: 'S3', level: 3 },
        ],
      });
      await classify('redo from here', 'prompt');
      // restored S2 (last logged turn with ts<=2500), fed to the classifier - the
      // stale S3 work never reaches it
      expect(captured[0].userPrompt).toContain('S2');
      expect(captured[0].userPrompt).not.toContain('S3 stale');
      expect(routerState().pendingRewindCut).toBeUndefined(); // consumed
      // log truncated to before the cut (S1) + this turn's fresh snapshot appended
      expect(routerState().log?.map(e => e.summary)).toEqual(['S1', 'S2']);
      expect(routerState().summary).toBe('after redo');
    });

    it('cold-resets on a rewind whose target predates the log (no stale carryover)', async () => {
      const { gb } = makeGB(['throw']); // fail-open exposes the post-reset level
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ pinPerTask: false })) as string,
        gb
      );
      setRouterState({
        pendingRewindCut: 50, // older than the earliest log entry (ts 1000)
        summary: 'stale',
        level: 3,
        log: [{ ts: 1000, summary: 'S1', level: 1 }],
      });
      await classify('redo', 'prompt');
      expect(routerState().summary).toBeUndefined(); // reset (no match)
      expect(routerState().effort).toBe('high'); // fail-open from reset, never silently low
    });

    it('rewind supersedes a co-pending compaction (no clobber of the restored state)', async () => {
      // Regression for the review bug: if /compact and /rewind both land before a
      // turn, the rewind cut must win - the compaction reseed must NOT overwrite
      // the rewind-restored summary with the (rewound-away) compaction text.
      const { gb, captured } = makeGB([{ level: 0, summary: 'after redo' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg({ pinPerTask: false })) as string,
        gb
      );
      setRouterState({
        pendingRewindCut: 2500, // -> restores the ts=2000 entry (S2)
        pendingCompaction: 'COMPACTION-OF-REWOUND-AWAY-WORK',
        summary: 'S3 stale',
        level: 3,
        log: [
          { ts: 1000, summary: 'S1', level: 1 },
          { ts: 2000, summary: 'S2', level: 2 },
        ],
      });
      await classify('redo from here', 'prompt');
      // the cut restored S2 and fed it; the compaction text never reaches the
      // classifier (rewind cleared pendingCompaction)
      expect(captured[0].userPrompt).toContain('S2');
      expect(captured[0].userPrompt).not.toContain(
        'COMPACTION-OF-REWOUND-AWAY'
      );
      expect(routerState().pendingCompaction).toBeUndefined(); // dropped by the rewind
    });

    it('fails open to HIGH on a classifier error (cold start)', async () => {
      const { gb } = makeGB(['throw']);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('do the thing', 'prompt');
      expect(routerState().effort).toBe('high');
    });

    it('clamps an out-of-range level and keeps the summary (robust parse)', async () => {
      const { gb } = makeGB([{ level: 99, summary: 'kept summary' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('do the thing', 'prompt');
      expect(routerState().level).toBe(3); // clamped to max, not fail-open
      expect(routerState().summary).toBe('kept summary'); // summary survives a bad level
    });

    it('keeps the last level (sticky) on a classifier error mid-session', async () => {
      const { gb } = makeGB([{ level: 1, summary: 's' }, 'throw']);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('a', 'prompt'); // medium
      await classify('b', 'prompt'); // throws -> sticky 1
      expect(routerState().effort).toBe('medium');
      expect(routerState().summary).toBe('s'); // summary preserved on failure
    });

    it('resets state + pin on /clear (incl. trailing whitespace)', async () => {
      const { gb } = makeGB([{ level: 2, summary: 's' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('fix the race condition', 'prompt');
      await classify('/clear\n', 'prompt');
      expect(routerState().level).toBeUndefined();
      expect(routerState().summary).toBeUndefined();
      expect(routerState().baseline).toBeUndefined();
    });

    it('ignores other slash commands and non-prompt modes', async () => {
      const { gb } = makeGB([{ level: 2, summary: 's' }]);
      const classify = extractClassify(
        writeComplexityRouter(FILE, cfg()) as string,
        gb
      );
      await classify('/theme', 'prompt');
      await classify('ls -la', 'bash');
      expect(routerState()?.effort).toBeUndefined();
    });
  });

  describe('effort-resolver wrap precedence (real injected logic)', () => {
    beforeEach(() => {
      delete (globalThis as unknown as Record<string, unknown>).__tweakccRouter;
    });

    const patched = () => writeComplexityRouter(FILE, cfg()) as string;

    it('OVERRIDES a persisted effort baseline (the inert-router bug)', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched());
      expect(XQ('m', 'xhigh')).toBe('medium'); // baseline<-xhigh; t===baseline -> router drives
      expect(XQ('m', 'xhigh')).toBe('medium');
    });

    it('YIELDS to an in-session /effort (fallback diverges from the launch baseline)', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched());
      expect(XQ('m', 'xhigh')).toBe('medium'); // launch baseline captured = xhigh
      expect(XQ('m', 'low')).toBe('YIELDED'); // user /effort'd to low
    });

    it('YIELDS to the CLAUDE_CODE_EFFORT_LEVEL env pin', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched(), { mUe: () => 'high' });
      expect(XQ('m', 'xhigh')).toBe('high');
    });

    it('drives when nothing is pinned and re-applies support guards', () => {
      setRouterState({ level: 1, effort: 'medium', baseline: undefined });
      const XQ = extractWrappedResolver(patched());
      expect(XQ('m', undefined)).toBe('medium');
      setRouterState({ level: 3, effort: 'max', baseline: undefined });
      const XQ2 = extractWrappedResolver(patched(), { dUe: () => false });
      expect(XQ2('m', undefined)).toBe('high'); // unsupported max -> high
    });

    it('end-to-end: real classify sets the effort, the real wrap overrides a baseline', async () => {
      const { gb } = makeGB([{ level: 0, summary: 's' }]);
      const p = patched();
      const classify = extractClassify(p, gb);
      const XQ = extractWrappedResolver(p); // shares globalThis.__tweakccRouter
      await classify('rename the variable', 'prompt'); // -> low
      expect(XQ('m', 'xhigh')).toBe('low'); // persisted xhigh overridden
    });

    it('captures the launch baseline on the first resolve while inactive (boot ordering)', async () => {
      const { gb } = makeGB([{ level: 0, summary: 's' }]);
      const p = patched();
      const XQ = extractWrappedResolver(p);
      const classify = extractClassify(p, gb);
      expect(XQ('m', 'xhigh')).toBe('YIELDED'); // no router effort yet
      expect(routerState().baseline).toBe('xhigh');
      await classify('rename the variable', 'prompt');
      expect(routerState().effort).toBe('low');
      expect(XQ('m', 'xhigh')).toBe('low'); // now drives
    });
  });

  describe('classifier call shape (H1 regression)', () => {
    // Extract the result parser + classifier and run against a stub gB/km to
    // PROVE it passes agentContext and parses {level, summary}.
    const buildLlm = () => {
      const patched = writeComplexityRouter(FILE, cfg()) as string;
      const m = patched.match(
        /function __tweakccRouterReadResult[\s\S]*?(?=async function __tweakccRouterClassify\()/
      );
      if (!m) throw new Error('classifier not found');
      let captured: { options?: Record<string, unknown> } = {};
      const stubGB = async (opts: { options?: Record<string, unknown> }) => {
        captured = opts;
        return {
          message: {
            content: [{ type: 'text', text: '{"level":2,"summary":"did x"}' }],
          },
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
        input: string,
        max: number
      ) => Promise<{ level: number; summary?: string } | null>;
      return { fn, getCaptured: () => captured };
    };

    it('passes a valid agentContext and parses {level, summary}', async () => {
      const { fn, getCaptured } = buildLlm();
      const res = await fn('refactor the whole auth subsystem', 3);
      expect(res).toEqual({ level: 2, summary: 'did x' });
      const opts = getCaptured().options as Record<string, unknown>;
      expect(opts.agentContext).toEqual({ agentType: 'main', agentId: 'x' });
      expect(opts.querySource).toBe('route_complexity');
      expect(opts.agents).toEqual([]);
    });
  });
});
