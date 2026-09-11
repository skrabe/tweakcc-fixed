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
    expect(out).toContain('o==="fableplan"');
    expect(out).toContain(
      'globalThis.__tweakccFablePlanModel=as(t==="plan"?"fable":"opus");'
    );
    // and clears the model global on the way past every other alias, so
    // switching away cannot leave a stale model steering the effort table
    expect(out).toContain('globalThis.__tweakccFablePlanModel=void 0;');
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
    // prefer the model uM recorded for this request.
    const out = writeFablePlan(cli + EFFORT_LOOKUP, config())!;
    expect(out).toContain(
      'return Z(e.settingsEffortTable,globalThis.__tweakccFablePlanModel??n??e.mainLoopModelForSession??'
    );
    // tweakcc no longer pins its own levels or shadows the effort resolver
    expect(out).not.toContain('__tweakccFablePlanEffort');
    expect(out).toContain(
      'function xte(e,t){if(!AO(e))return;let r=m1e(e),n=Uet(e),o=Xbt();return o}'
    );
    expect(writeFablePlan(out, config())).toBe(out);
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
    expect(out).toContain('as(t==="plan"?"opus":"sonnet")');
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
    expect(out).toContain('lf()==="fableplan"');
    expect(out).toContain('Ot(t==="plan"?"fable":"opus")');
    expect(out).toContain(
      'if(t!=="plan")return r;let u=lf(),d=qde(u);if(d===null)return r;return r}'
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
      'if(lf()==="fableplan"){globalThis.__tweakccFablePlanModel=Ot(t==="plan"?"fable":"opus");' +
        'return{model:globalThis.__tweakccFablePlanModel,clampWarning:null}}' +
        'globalThis.__tweakccFablePlanModel=void 0;if(t!=="plan")return{model:r,clampWarning:null};'
    );
    expect(out).toContain(
      'settingsEffortTable,globalThis.__tweakccFablePlanModel??n??'
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

  it('is idempotent on the CC 2.1.251 shape', () => {
    const once = writeFablePlan(cli251, config())!;
    const twice = writeFablePlan(once, config())!;
    expect(twice).toBe(once);
  });
});
