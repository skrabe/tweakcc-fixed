import vm from 'node:vm';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { writeFablePlan } from './fablePlan';
import { DEFAULT_SETTINGS } from '../defaultSettings';
import { FablePlanConfig } from '../types';

const config = (over: Partial<FablePlanConfig> = {}): FablePlanConfig => ({
  ...DEFAULT_SETTINGS.fablePlan,
  enabled: true,
  ...over,
});

// The six sites the patch needs, in the shapes CC 2.1.228 ships them.
const cli = [
  // 1. alias whitelist, read by the `sM()` membership check
  'h9e=["sonnet","opus","haiku","fable","best","opusplan"],_an=["sonnet","opus","haiku","fable"]});',
  // 2. per-request model resolver
  'function uM(e){let{permissionMode:t,mainLoopModel:r,exceeds200kTokens:n=!1}=e,o=tW();' +
    'if((o==="opusplan"||o==="opusplan[1m]")&&t==="plan"&&!n){return ww()}return r}',
  // 3. builtin-default switch
  'function Gvo(e){let t=T9e();switch(e){case"opus":return zZe(t);case"sonnet":return Kvo(t);' +
    'case"haiku":return mTs(t);case"fable":return pTs(t);case"opusplan":return Kvo(t);default:return null}}',
  // 4. alias -> concrete model
  'function as(e){let t=e.trim(),r=t.toLowerCase(),n=bT(r),o=n?Ma(r).trim():r;if(sM(o))switch(o){' +
    'case"fable":{let i=pcn();return aM(i)}case"opusplan":return n?aM(vJ(yk())):yk();' +
    'case"sonnet":return n?aM(vJ(yk())):yk();case"haiku":return n?aM(vJ(GZe())):GZe();' +
    'case"opus":return n?aM(vJ(ww())):ww();case"best":return Xvu();default:}return null}',
  // 5. `/model` picker options
  'function qB_(e,t){let r=BB_(e),n=X.ANTHROPIC_CUSTOM_MODEL_OPTION;return r}',
  // 6. effort resolver, plus the clear-context gate
  'function xte(e,t){if(!AO(e))return;let r=m1e(e),n=Uet(e),o=Xbt();return o}',
  'let p=it((yt)=>yt.settings.showClearContextOnPlanAccept)??!1,f=2;',
].join('');

// CC 2.1.251: plan resolver is table-driven (getter after an early
// `if(mode!=="plan")return`); effort resolver took `{honorLaunchPin}`.
const cli251 = [
  'pN=["sonnet","opus","haiku","fable","best","opusplan"],Cwt=["sonnet","opus","haiku","fable"]});',
  'function hp(e){let{permissionMode:t,mainLoopModel:r,exceeds200kTokens:o=!1}=e;' +
    'if(t!=="plan")return r;let u=lf(),d=qde(u);if(d===null)return r;return r}',
  'function xs(e){let t=Pt();switch(e){case"opus":return Nt(t);case"sonnet":return Fs(t);' +
    'case"haiku":return Su(t);case"fable":return Eu(t);case"opusplan":return Fs(t);default:return null}}',
  'function Ot(e){let t=e.trim(),r=t.toLowerCase(),o=Cc(r),u=o?pn(r).trim():r;if(Bm(u))switch(u){' +
    'case"fable":{let d=jSt();return XS(d)}case"opusplan":return o?XS(Xe(uf())):uf();' +
    'case"sonnet":return o?XS(Xe(uf())):uf();case"haiku":return o?XS(Xe(MV())):MV();' +
    'case"opus":return o?XS(Xe(bl())):bl();case"best":return Zyr();default:}return null}',
  'function ln(e,o){let t=tn(e),s=a.ANTHROPIC_CUSTOM_MODEL_OPTION;return t}',
  'function yT(e,o,{honorLaunchPin:t=!0}={}){if(!lg(e))return;let r=t&&LM(e),u=C(e),f=mH();return f}',
  'let Fe=W((Qt)=>Qt.settings.showClearContextOnPlanAccept)??!1,Ve=2;',
].join('');

// CC >= 2.1.265: the session-effort resolver reads the per-model table keyed on
// the session model.
const EFFORT_LOOKUP =
  'function ul(e,n){let o=e.sessionEffort??Y;switch(o.kind){case"level":return o.value;case"default":return;' +
  'case"inherit":if(e.settingsEffortTable===void 0)return;if(!ee(e.settingsEffortTable))return e.settingsEffortTable.default;' +
  'return Z(e.settingsEffortTable,n??e.mainLoopModelForSession??e.mainLoopModel??dl())}}';

// CC >= 2.1.280: the table guard flipped polarity — `if(!ee(TABLE))` became
// `if(se(TABLE))`, the negation moving into the predicate. The splice site is
// unchanged, so the match must not depend on which way the guard reads.
const EFFORT_LOOKUP_280 = EFFORT_LOOKUP.replace(
  'if(!ee(e.settingsEffortTable))',
  'if(se(e.settingsEffortTable))'
);

// CC >= 2.1.291: the inherit arm is a block that names the model first, so a
// carried fallback effort can hold the lookup, and the default shortcut also
// checks for that carry.
const EFFORT_LOOKUP_291 =
  'function Qk(e,n,{withHold:r=!0}={}){let s=e.sessionEffort??Y;switch(s.kind){case"level":return s.value;case"default":return;' +
  'case"inherit":{if(e.settingsEffortTable===void 0)return;if(qe(e.settingsEffortTable)&&!J())return e.settingsEffortTable.default;' +
  'let d=n??e.mainLoopModelForSession??e.mainLoopModel??dl();return r&&Hx(d)!==void 0?void 0:Z(e.settingsEffortTable,d)}}}';

// CC 2.1.291's per-request effort resolver and the effective-permission-context
// function it sits beside, which `uM` callers read the request's mode from.
const EFFORT_CALLER_291 =
  'function de(e){let o=e.getAppState().toolPermissionContext;for(let t of e.permissionLayers??[])' +
  'if(t.kind==="permission_mode")o={...o,mode:t.mode};return o}' +
  'function bh(e){return Sh(e.permissionLayers)??Qk(e.getAppState(),p(e),{withHold:jr(e)})}' +
  'function bq(e){return bh(e)===void 0?Qk(e.getAppState(),p(e),{withHold:!1}):void 0}' +
  // hook input: the context is optional
  'function yd(e,n,r,s){let h=s?.options?.mainLoopModel,b=Qk(s?.getAppState?.()??{},h,{withHold:jr(s??{})});return b}' +
  // subagent spawn: `model` is already routed with the subagent's own mode
  'function Cz(e){return Qk(e,dl())}' +
  'function bln({agentDefinition:e,isFork:t,model:r,effortState:n,inheritedLayers:s}){let l=Cz(n),i=Qk(n,r);return i}';

const KEY_291 =
  'let d=globalThis.__tweakccFablePlanModelFor?.(e.__tweakccPermissionMode??e.toolPermissionContext?.mode)' +
  '??n??e.mainLoopModelForSession??e.mainLoopModel??dl();';

// A runnable 2.1.291-shaped bundle: every site the patch needs, as code that
// executes, so the tests can drive real requests through the patched output.
const RUNNABLE_291 = [
  'var SEL="fableplan";function setSel(v){SEL=v}function wy(){return SEL}',
  'var Wl=["sonnet","opus","haiku","fable","best","opusplan"],Xl=["sonnet","opus","haiku","fable"];',
  'function Ah(e){return Wl.includes(e)}function Om(){return"claude-opus-5"}function Fm(){return"claude-fable-5"}',
  'function Bd(e){let t=0;switch(e){case"fable":return Fm(t);case"opus":return Om(t);default:return null}}',
  'function xt(e){let t=e.trim(),r=t.toLowerCase();if(Ah(r))switch(r){case"fable":return Fm();' +
    'case"opusplan":return Om();case"opus":return Om();default:}return t}',
  'function Pk(e,t){let r=Bk(e),n=X.ANTHROPIC_CUSTOM_MODEL_OPTION;return r}',
  'function am(e){return Hcr(e).model}',
  'function Hcr(e){let{permissionMode:n,mainLoopModel:r,exceeds200kTokens:s=!1}=e;' +
    'if(n!=="plan")return{model:r,clampWarning:null};let g=wy(),h=g==="opusplan"?Om():null;' +
    'return{model:h??r,clampWarning:null}}',
  'function qe(t){return Object.keys(t.byModel).length===0}function J(){return!1}function Hx(m){return}',
  'function re(t,m){return t.byModel[m]??t.default}function dl(){return xt(wy())}',
  'function Qk(e,n,{withHold:r=!0}={}){let s=e.sessionEffort??{kind:"inherit"};switch(s.kind){' +
    'case"level":return s.value;case"default":return;' +
    'case"inherit":{if(e.settingsEffortTable===void 0)return;if(qe(e.settingsEffortTable)&&!J())return e.settingsEffortTable.default;' +
    'let d=n??e.mainLoopModelForSession??e.mainLoopModel??dl();return r&&Hx(d)!==void 0?void 0:re(e.settingsEffortTable,d)}}}',
  'function Sh(l){let o;for(let n of l??[])if(n.kind==="effort")o=n.effort;return o}function jr(e){return!0}',
  'function p(e){return e.options.mainLoopModel}',
  'function LF(m,mode){return am({permissionMode:mode??"default",mainLoopModel:m})}',
  EFFORT_CALLER_291,
].join('');

type Runtime = {
  setSel: (alias: string) => void;
  am: (args: { permissionMode: string; mainLoopModel: string }) => string;
  bh: (ctx: unknown) => string | undefined;
  de: (ctx: unknown) => { mode: string };
  yd: (a: unknown, b: unknown, c: unknown, ctx?: unknown) => string | undefined;
  LF: (model: string, mode?: string) => string;
  bln: (args: {
    agentDefinition: unknown;
    isFork: boolean;
    model: string;
    effortState: unknown;
  }) => string | undefined;
};

const run = (src: string): Runtime =>
  vm.runInNewContext(`${src};({setSel,am,bh,de,yd,LF,bln})`) as Runtime;

describe('writeFablePlan', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('registers the alias in the whitelist that gates every other site', () => {
    // `sM(e){return h9e.includes(e)}` rejects anything absent here, so without
    // this splice the other five are inert.
    const out = writeFablePlan(cli, config());
    expect(out).not.toBeNull();
    expect(out).toContain('"opusplan","fableplan"]');
  });

  it('resolves the plan model only for its own alias', () => {
    const out = writeFablePlan(cli, config())!;
    // Plan mode only: the exec side is CC's own resolution of the session model.
    expect(out).toContain(
      '=e,o=tW();if(t==="plan"&&o==="fableplan")return as("fable");'
    );
    // The stateless answer for the effort lookup, defined beside the resolver.
    expect(out).toContain(
      'globalThis.__tweakccFablePlanModelFor=(m)=>m==="plan"&&tW()==="fableplan"?as("fable"):void 0;function uM('
    );
    // Nothing the resolver does is remembered between calls.
    expect(out).not.toContain('__tweakccFablePlanModel=');
    // CC's own branches survive untouched — this must not change any other model
    expect(out).toContain(
      'if((o==="opusplan"||o==="opusplan[1m]")&&t==="plan"&&!n)'
    );
    expect(out).toContain('return r}');
  });

  it('rests on the exec model in both alias resolvers', () => {
    const out = writeFablePlan(cli, config())!;
    // clones the exec alias's own arm rather than inventing one
    expect(out).toContain('case"fableplan":return n?aM(vJ(ww())):ww();');
    expect(out).toContain('case"fableplan":return zZe(t);');
  });

  it('keys the per-model effort lookup on the answering model', () => {
    // The table is looked up by the SESSION model, which for fableplan resolves
    // to the exec model, so a plan turn would read Opus's level. The lookup must
    // ask fableplan's answer for this request's permission mode first.
    const out = writeFablePlan(cli + EFFORT_LOOKUP, config())!;
    expect(out).toContain(
      'return Z(e.settingsEffortTable,globalThis.__tweakccFablePlanModelFor?.(e.__tweakccPermissionMode??e.toolPermissionContext?.mode)??n??e.mainLoopModelForSession??'
    );
    // tweakcc no longer pins its own levels or shadows the effort resolver
    expect(out).not.toContain('__tweakccFablePlanEffort');
    expect(out).toContain(
      'function xte(e,t){if(!AO(e))return;let r=m1e(e),n=Uet(e),o=Xbt();return o}'
    );
    expect(writeFablePlan(out, config())).toBe(out);
  });

  it('keys the effort lookup through the CC 2.1.280 inverted table guard', () => {
    const out = writeFablePlan(cli + EFFORT_LOOKUP_280, config())!;
    expect(out).toContain(
      'return Z(e.settingsEffortTable,globalThis.__tweakccFablePlanModelFor?.(e.__tweakccPermissionMode??e.toolPermissionContext?.mode)??n??e.mainLoopModelForSession??'
    );
    // The guard itself is left exactly as CC wrote it.
    expect(out).toContain('if(se(e.settingsEffortTable))');
    expect(writeFablePlan(out, config())).toBe(out);
  });

  it('keys the CC 2.1.291 block-form effort lookup, hold check included', () => {
    const out = writeFablePlan(
      cli + EFFORT_LOOKUP_291 + EFFORT_CALLER_291,
      config()
    )!;
    expect(out).not.toBeNull();
    // One key feeds both the carried-effort hold and the table lookup.
    expect(out).toContain(
      KEY_291 + 'return r&&Hx(d)!==void 0?void 0:Z(e.settingsEffortTable,d)}'
    );
    expect(out).toContain(
      'if(qe(e.settingsEffortTable)&&!J())return e.settingsEffortTable.default;'
    );
    expect(out.split('__tweakccFablePlanModelFor?.(').length - 1).toBe(1);
    // Both per-request callers hand over the request's effective mode.
    expect(out).toContain(
      '??Qk({...e.getAppState(),__tweakccPermissionMode:de(e).mode},p(e),{withHold:jr(e)})}'
    );
    expect(out).toContain(
      '?Qk({...e.getAppState(),__tweakccPermissionMode:de(e).mode},p(e),{withHold:!1}):void 0}'
    );
    expect(out).toContain(
      'b=Qk({...s?.getAppState?.()??{},__tweakccPermissionMode:s?.getAppState?de(s).mode:void 0},h,'
    );
    expect(out).toContain(
      'let l=Cz(n),i=Qk({...n,__tweakccPermissionMode:"routed"},r);'
    );
    // the session-scoped caller keeps the session's mode
    expect(out).toContain('function Cz(e){return Qk(e,dl())}');
    expect(writeFablePlan(out, config())).toBe(out);
  });

  it('fails loudly when the CC 2.1.291 hook-input or spawn effort caller drifts', () => {
    for (const [from, to] of [
      ['Qk(s?.getAppState?.()??{},h', 'Qk(s?.getAppState?.()??0,h'],
      ['i=Qk(n,r)', 'i=Qk(r,n)'],
    ]) {
      const drifted = EFFORT_CALLER_291.replace(from, to);
      expect(drifted).not.toBe(EFFORT_CALLER_291);
      expect(
        writeFablePlan(cli + EFFORT_LOOKUP_291 + drifted, config())
      ).toBeNull();
    }
  });

  it('fails loudly when the CC 2.1.291 per-request effort caller drifts', () => {
    const drifted = EFFORT_CALLER_291.replaceAll(
      'Qk(e.getAppState(),p(e)',
      'Qk(e.getAppState(),p(e,1)'
    );
    expect(
      writeFablePlan(cli + EFFORT_LOOKUP_291 + drifted, config())
    ).toBeNull();
  });

  it("a plan-mode probe of the resolver cannot move the next request's effort", () => {
    // CC asks the resolver "what would plan mode use" as a probe
    // (`uM({permissionMode:"plan",mainLoopModel:s})`). The effort an exec
    // request reads must depend on that request alone.
    const out = writeFablePlan(RUNNABLE_291, config());
    expect(out).not.toBeNull();
    const rt = run(out!);
    const state = {
      toolPermissionContext: { mode: 'default' },
      settingsEffortTable: {
        default: 'medium',
        byModel: { 'claude-fable-5': 'max', 'claude-opus-5': 'low' },
      },
    };
    const ctx = {
      getAppState: () => state,
      options: { mainLoopModel: 'claude-opus-5' },
      permissionLayers: [],
    };
    const exec = { permissionMode: 'default', mainLoopModel: 'claude-opus-5' };
    expect(rt.am(exec)).toBe('claude-opus-5');
    expect(rt.bh(ctx)).toBe('low');
    expect(rt.am({ ...exec, permissionMode: 'plan' })).toBe('claude-fable-5');
    expect(rt.bh(ctx)).toBe('low');
    expect(rt.am(exec)).toBe('claude-opus-5');

    // A real plan turn reads the planning model's level, and stops on exit.
    state.toolPermissionContext.mode = 'plan';
    expect(rt.am({ ...exec, permissionMode: 'plan' })).toBe('claude-fable-5');
    expect(rt.bh(ctx)).toBe('max');
    state.toolPermissionContext.mode = 'default';
    expect(rt.bh(ctx)).toBe('low');
  });

  it('keys effort on the mode the request is routed on, layers included', () => {
    const rt = run(writeFablePlan(RUNNABLE_291, config())!);
    const state = {
      toolPermissionContext: { mode: 'plan' },
      settingsEffortTable: {
        default: 'medium',
        byModel: { 'claude-fable-5': 'max', 'claude-opus-5': 'low' },
      },
    };
    // A context whose permission layer puts it in default mode while the
    // session plans: routed to the exec model, so it reads the exec level.
    const layered = {
      getAppState: () => state,
      options: { mainLoopModel: 'claude-opus-5' },
      permissionLayers: [{ kind: 'permission_mode', mode: 'default' }],
    };
    const mode = rt.de(layered).mode;
    expect(
      rt.am({ permissionMode: mode, mainLoopModel: 'claude-opus-5' })
    ).toBe('claude-opus-5');
    expect(rt.bh(layered)).toBe('low');
    // And the reverse: a plan layer on a default-mode session.
    state.toolPermissionContext.mode = 'default';
    const planLayer = {
      ...layered,
      permissionLayers: [{ kind: 'permission_mode', mode: 'plan' }],
    };
    expect(rt.bh(planLayer)).toBe('max');
  });

  it('a subagent keys effort on the model its own mode routes it to', () => {
    // A fableplan parent plans and spawns a Haiku subagent. Routing mirrors
    // opusplan: the subagent's own effective mode decides, and the effort
    // lookup follows whatever the router picked.
    const rt = run(writeFablePlan(RUNNABLE_291, config())!);
    const state = {
      toolPermissionContext: { mode: 'plan' },
      settingsEffortTable: {
        default: 'medium',
        byModel: {
          'claude-fable-5': 'max',
          'claude-opus-5': 'low',
          'claude-haiku-5': 'high',
        },
      },
    };
    type Ctx = {
      getAppState: () => typeof state;
      options: { mainLoopModel: string };
      permissionLayers: { kind: string; mode: string }[];
    };
    const parent: Ctx = {
      getAppState: () => state,
      options: { mainLoopModel: 'claude-opus-5' },
      permissionLayers: [],
    };
    const route = (ctx: Ctx) =>
      rt.am({
        permissionMode: rt.de(ctx).mode,
        mainLoopModel: ctx.options.mainLoopModel,
      });
    expect(route(parent)).toBe('claude-fable-5');
    expect(rt.bh(parent)).toBe('max');

    // Default-mode layer: runs Haiku, reads Haiku's level.
    const subagent: Ctx = {
      getAppState: () => state,
      options: { mainLoopModel: 'claude-haiku-5' },
      permissionLayers: [{ kind: 'permission_mode', mode: 'default' }],
    };
    expect(route(subagent)).toBe('claude-haiku-5');
    expect(rt.bh(subagent)).toBe('high');

    // Inheriting plan mode: routed to Fable like opusplan, reads Fable's level.
    const inPlan: Ctx = { ...subagent, permissionLayers: [] };
    expect(route(inPlan)).toBe('claude-fable-5');
    expect(rt.bh(inPlan)).toBe('max');

    expect(rt.bh(parent)).toBe('max');
  });

  it('a default-mode Haiku subagent of a planning session reads Haiku, at spawn and in hooks', () => {
    const rt = run(writeFablePlan(RUNNABLE_291, config())!);
    const state = {
      toolPermissionContext: { mode: 'plan' },
      settingsEffortTable: {
        default: 'medium',
        byModel: {
          'claude-fable-5': 'max',
          'claude-opus-5': 'low',
          'claude-haiku-5': 'high',
        },
      },
    };
    // Spawn: routed with the subagent's own mode, then its effort is read.
    const model = rt.LF('claude-haiku-5', 'default');
    expect(model).toBe('claude-haiku-5');
    expect(
      rt.bln({ agentDefinition: {}, isFork: false, model, effortState: state })
    ).toBe('high');
    // Hook input from inside that subagent.
    const sub = {
      getAppState: () => state,
      options: { mainLoopModel: 'claude-haiku-5' },
      permissionLayers: [{ kind: 'permission_mode', mode: 'default' }],
    };
    expect(rt.yd({}, '/', 'default', sub)).toBe('high');
    // A plan-mode spawn is routed to Fable like opusplan, and reads Fable.
    const planned = rt.LF('claude-haiku-5', 'plan');
    expect(planned).toBe('claude-fable-5');
    expect(
      rt.bln({
        agentDefinition: {},
        isFork: false,
        model: planned,
        effortState: state,
      })
    ).toBe('max');
    // No context: hook input keeps the session's mode.
    expect(rt.yd({}, '/', 'plan')).toBe(undefined);
  });

  it('leaves every other alias and every exec-side model to Claude Code', () => {
    const rt = run(writeFablePlan(RUNNABLE_291, config())!);
    const state = {
      toolPermissionContext: { mode: 'plan' },
      settingsEffortTable: {
        default: 'medium',
        byModel: { 'claude-fable-5': 'max', 'claude-opus-5': 'low' },
      },
    };
    const ctx = {
      getAppState: () => state,
      options: { mainLoopModel: 'claude-opus-5' },
      permissionLayers: [],
    };
    // An exec-side request keeps whatever model it was given, e.g. a subagent
    // configured for haiku.
    expect(
      rt.am({ permissionMode: 'default', mainLoopModel: 'claude-haiku-5' })
    ).toBe('claude-haiku-5');
    rt.setSel('opus');
    expect(
      rt.am({ permissionMode: 'plan', mainLoopModel: 'claude-opus-5' })
    ).toBe('claude-opus-5');
    expect(rt.bh(ctx)).toBe('low');
  });

  it('refuses to call an alias-to-model function from another bundle module', () => {
    // On a code-split bundle the resolver found by shape must be callable
    // where the plan-mode branch is spliced.
    const mark = (n: number) =>
      `/*@@TWEAKCC_MODULE:${n}:/$bunfs/root/chunk-${n}.js@@*/`;
    const asFn = cli.match(/function as\(e\)\{[\s\S]*?return null\}/)![0];
    const split = mark(1) + asFn + mark(2) + cli.replace(asFn, '');
    expect(writeFablePlan(split, config())).toBeNull();
  });

  it('fails loudly when the lookup no longer leads with its model argument', () => {
    const drifted = EFFORT_LOOKUP_291.replace(
      'let d=n??e.mainLoopModelForSession??',
      'let d=e.mainLoopModelForSession??n??'
    );
    expect(drifted).not.toBe(EFFORT_LOOKUP_291);
    expect(
      writeFablePlan(cli + drifted + EFFORT_CALLER_291, config())
    ).toBeNull();
  });

  it('fails loudly when the CC 2.1.291 effort lookup key drifts', () => {
    const drifted = EFFORT_LOOKUP_291.replace(
      'Z(e.settingsEffortTable,d)',
      'Z(e.settingsEffortTable,d2)'
    );
    expect(writeFablePlan(cli + drifted, config())).toBeNull();
  });

  it('fails loudly when the per-model effort lookup drifts', () => {
    const drifted = EFFORT_LOOKUP.replace(
      '.default;return Z(',
      '.default;return Z2(0,'
    );
    expect(writeFablePlan(cli + drifted, config())).toBeNull();
  });

  it('offers the clear-context option Claude Code defaults off', () => {
    const out = writeFablePlan(cli, config())!;
    expect(out).toContain('showClearContextOnPlanAccept)??!0');
  });

  it('leaves the clear-context default alone when the user turned it off', () => {
    const out = writeFablePlan(
      cli,
      config({ offerClearContextOnPlanAccept: false })
    )!;
    expect(out).toContain('showClearContextOnPlanAccept)??!1');
  });

  it('honours a different pairing', () => {
    const out = writeFablePlan(
      cli,
      config({ planModel: 'opus', execModel: 'sonnet' })
    )!;
    expect(out).toContain('if(t==="plan"&&o==="fableplan")return as("opus");');
    // the exec side rests on the exec model's own arm
    expect(out).toContain('case"fableplan":return n?aM(vJ(yk())):yk();');
    expect(out).toContain('"label":"Opus Plan Mode"');
  });

  it('adds the alias to the model picker', () => {
    const out = writeFablePlan(cli, config())!;
    expect(out).toContain('"value":"fableplan"');
    expect(out).toContain('Use Fable in plan mode, Opus otherwise');
  });

  it('is idempotent — a re-apply changes nothing', () => {
    // Five of the six anchors match their own output, so without the
    // already-applied marker a second run injects a second set of splices.
    const once = writeFablePlan(cli, config())!;
    const twice = writeFablePlan(once, config())!;
    expect(twice).toBe(once);
  });

  it('refuses a pairing of a model with itself', () => {
    expect(
      writeFablePlan(cli, config({ planModel: 'opus', execModel: 'opus' }))
    ).toBeNull();
  });

  it('fails loudly when the alias whitelist is gone', () => {
    expect(
      writeFablePlan(cli.replace('"opusplan"],', '],'), config())
    ).toBeNull();
  });

  it('no-ops the effort splice on builds without a per-model effort table', () => {
    // Before CC grew per-model levels, effort simply follows the session.
    const out = writeFablePlan(cli, config());
    expect(out).not.toBeNull();
    expect(out).toContain('"value":"fableplan"');
    expect(out).not.toContain('settingsEffortTable');
  });

  it('applies against the CC 2.1.251 table-driven plan resolver', () => {
    const out = writeFablePlan(cli251, config());
    expect(out).not.toBeNull();
    expect(out).toContain('"opusplan","fableplan"]');
    expect(out).toContain(
      'if(t!=="plan")return r;if(lf()==="fableplan")return Ot("fable");' +
        'let u=lf(),d=qde(u);if(d===null)return r;return r}'
    );
    expect(out).toContain(
      'function yT(e,o,{honorLaunchPin:t=!0}={}){if(!lg(e))return;'
    );
    expect(out).toContain('case"fableplan":return o?XS(Xe(bl())):bl();');
    expect(out).toContain('case"fableplan":return Nt(t);');
  });

  it('applies against the CC 2.1.268 object-returning plan resolver', () => {
    const resolver251 =
      'function hp(e){let{permissionMode:t,mainLoopModel:r,exceeds200kTokens:o=!1}=e;' +
      'if(t!=="plan")return r;let u=lf(),d=qde(u);if(d===null)return r;return r}';
    const resolver268 =
      'function hp(e){let{model:n,clampWarning:r}=YQt(e);return n}' +
      'function YQt(e){let{permissionMode:t,mainLoopModel:r,exceeds200kTokens:o=!1}=e;' +
      'if(t!=="plan")return{model:r,clampWarning:null};let u=lf(),d=qde(u);' +
      'if(d===null)return{model:r,clampWarning:null};return{model:r,clampWarning:null}}';
    const src = cli251.replace(resolver251, resolver268) + EFFORT_LOOKUP;
    expect(src).toContain(resolver268);
    const out = writeFablePlan(src, config());
    expect(out).not.toBeNull();
    expect(out).toContain(
      'globalThis.__tweakccFablePlanModelFor=(m)=>m==="plan"&&lf()==="fableplan"?Ot("fable"):void 0;' +
        'function YQt(e){let{permissionMode:t,mainLoopModel:r,exceeds200kTokens:o=!1}=e;' +
        'if(t!=="plan")return{model:r,clampWarning:null};' +
        'if(lf()==="fableplan")return{model:Ot("fable"),clampWarning:null};let u=lf(),'
    );
    expect(out).toContain(
      'settingsEffortTable,globalThis.__tweakccFablePlanModelFor?.(e.__tweakccPermissionMode??e.toolPermissionContext?.mode)??n??'
    );
    expect(writeFablePlan(out!, config())).toBe(out);
  });

  it('adds the alias to the CC 2.1.268 flag-merged model picker', () => {
    const src = cli251.replace(
      /function ln\(e,o\)\{let t=tn\(e\),s=a\.ANTHROPIC_CUSTOM_MODEL_OPTION;/,
      'function ln(e,o){let r=Wk(e,o),t=r??tn(e),d=r!==null&&Pl()==="flag";if(d){t.push(1)}let p=r===null||d,s=a.ANTHROPIC_CUSTOM_MODEL_OPTION;'
    );
    expect(src).toContain('d=r!==null&&Pl()==="flag";');
    const out = writeFablePlan(src, config());
    expect(out).not.toBeNull();
    expect(out).toContain(
      'd=r!==null&&Pl()==="flag";if(!t.some((z)=>z.value==="fableplan"))t.push('
    );
    const pushes = 't.push({"value":"claude-opus-4-6"});'.repeat(20);
    const crowded = src.replace(
      'd=r!==null&&Pl()==="flag";',
      `d=r!==null&&Pl()==="flag";${pushes}`
    );
    expect(writeFablePlan(crowded, config())).toContain(
      `flag";if(!t.some((z)=>z.value==="fableplan"))t.push(`
    );
  });

  it('drops the single effort control on the fableplan picker row', () => {
    const picker =
      'Ze({"modelPicker:decreaseEffort":()=>{Ws("left")}});' +
      'Ws=oe((Bs)=>{let di=ko(),ra=yn.find((qn)=>qn.value===di);if(ra===void 0||ra.disabled===!0)return;' +
      'let $a=hne(di);if(!$a.supportsEffort)return;jn(1)},[yn]);' +
      'function es(Bs){let di=HT(Bs),ra=di&&In!==void 0&&In!=="ultracode"?W1(In,di):In;' +
      'if(i("tengu_model_command_menu_effort",{effort:we(ra)}),!Oe&&gr)Je(1);let $a=ra;' +
      'if(Bs===EC){ee(null,$a);return}ee(Bs,$a)}' +
      'hi!==void 0&&!ai&&e(o,{marginBottom:1,flexDirection:"column",children:oi?r(F,{children:[1]}):' +
      'r(n,{color:"subtle",children:[e(jY,{effort:void 0})," Effort not supported",Vi?` for ${Vi}`:""]})})';
    const out = writeFablePlan(cli + picker, config())!;
    expect(out).toContain('if(di==="fableplan")return;let $a=hne(di)');
    expect(out).toContain(
      'children:hi==="fableplan"?r(n,{color:"subtle",children:["Fable and Opus each use their own effort (set it on their rows)"]}):oi?'
    );
    expect(out).toContain(
      'function es(Bs){if(Bs==="fableplan"){ee(Bs,void 0);return}let di=HT(Bs)'
    );
    expect(writeFablePlan(out, config())).toBe(out);
    // a build that has the effort control but a drifted shape fails loudly
    expect(
      writeFablePlan(
        cli +
          picker.replace('supportsEffort)return;', 'supportsEffort)return 0;'),
        config()
      )
    ).toBeNull();
  });

  it('drops the effort control on the CC 2.1.281 getter-based commit', () => {
    // 2.1.281 reads effort through getters inside the commit and fires the
    // analytics call as a bare statement; the ultracode session write is gone.
    const picker =
      'Ze({"modelPicker:decreaseEffort":()=>{Ws("left")}});' +
      'Ws=oe((Bs)=>{let di=ko(),ra=yn.find((qn)=>qn.value===di);if(ra===void 0||ra.disabled===!0)return;' +
      'let $a=hne(di);if(!$a.supportsEffort)return;jn(1)},[yn]);' +
      'function Dr(cs){let Ts=vy(cs),Hs=Pn(),_i=qo(),fi=Ts&&Hs!==void 0&&Hs!=="ultracode"?yG(Hs,Ts):Hs;' +
      'i("tengu_model_command_menu_effort",{effort:pe(fi)});let Nr=_i&&Ts&&qS(Ts)?fi:void 0;' +
      'if(cs===sh){D(null,Nr);return}D(cs,Nr)}' +
      'hi!==void 0&&!ai&&e(o,{marginBottom:1,flexDirection:"column",children:oi?r(F,{children:[1]}):' +
      'r(n,{color:"subtle",children:[e(jY,{effort:void 0})," Effort not supported",Vi?` for ${Vi}`:""]})})';
    const out = writeFablePlan(cli + picker, config())!;
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function Dr(cs){if(cs==="fableplan"){D(cs,void 0);return}let Ts=vy(cs),Hs=Pn()'
    );
    expect(out).toContain('if(di==="fableplan")return;let $a=hne(di)');
    expect(writeFablePlan(out, config())).toBe(out);
  });

  it('drops the effort control on the CC 2.1.284 commit without the ultracode guard', () => {
    // 2.1.284 moved ultracode off the effort scale onto its own session flag,
    // so the commit clamps the level without excluding it first.
    const picker =
      'Vt({"modelPicker:decreaseEffort":()=>{br("left")}});' +
      'br=ie((es)=>{let ss=Yt(),Cs=Rn.find((Is)=>Is.value===ss);if(Cs===void 0||Cs.disabled===!0)return;' +
      'let ws=G$(ss);if(!ws.supportsEffort)return;Vo(!0)},[Rn]);' +
      'function ir(es){let ss=wy(es),Cs=nn(),ws=Yo(),Is=ss&&Cs!==void 0?zV(Cs,ss):Cs;' +
      'i("tengu_model_command_menu_effort",{effort:ue(Is)});let js=ws&&ss&&qb(ss)?Is:void 0;' +
      'if(es===Vg){D(null,js);return}D(es,js)}' +
      'En!==void 0&&!fr&&e(s,{marginBottom:1,flexDirection:"column",children:Vn?r(F,{children:[1]}):' +
      'r(n,{color:"subtle",children:[e(dN,{effort:void 0})," Effort not supported",Vi?` for ${Vi}`:""]})})';
    const out = writeFablePlan(cli + picker, config())!;
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function ir(es){if(es==="fableplan"){D(es,void 0);return}let ss=wy(es),Cs=nn()'
    );
    expect(out).toContain('if(ss==="fableplan")return;let ws=G$(ss)');
    expect(out).toContain('children:En==="fableplan"?r(n,{color:"subtle"');
    expect(writeFablePlan(out, config())).toBe(out);
  });

  it('is idempotent on the CC 2.1.251 shape', () => {
    const once = writeFablePlan(cli251, config())!;
    const twice = writeFablePlan(once, config())!;
    expect(twice).toBe(once);
  });
});
