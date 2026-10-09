import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  ROUTER_TURN_STATUS_RUNTIME,
  writeComplexityRouterTurnStatus,
} from './complexityRouterTurnStatus';

const fixture =
  'function duration(e,n,r,s,g){return{type:"system",subtype:"turn_duration",durationMs:e,budgetTokens:n?.tokens,messageCount:r,pendingBackgroundAgentCount:s,pendingWorkflowCount:g}}' +
  'function*query(e,n,r,s,g,h){let S=f=>f(),model=h.model;let effort=S(()=>resolve(model,h.effortValue,{turnEffort:h.turnEffort,hookEffortValue:h.hookEffortValue}));yield effort}' +
  'function finish(messages){return messages.map((last)=>duration(last.durationMs,budget,count(messages,N),last.pendingBackgroundAgentCount,last.pendingWorkflowCount))}' +
  'function finishSwarm(ee){return duration(D,V,U(ee,nC))}' +
  'function render(m){let{message:l,addMargin:p,verb:h}=m,q="42s",W="5:17 PM";return{children:`${h} for ${q}${W?` \\xB7 done ${W}`:""}`}}';

function harness() {
  const context = vm.createContext({});
  vm.runInContext(ROUTER_TURN_STATUS_RUNTIME, context);
  const run = (source: string) => vm.runInContext(source, context);
  run(
    'var messages=[{type:"user",uuid:"turn-1",message:{content:"hello"}}];var options={querySource:"repl_main_thread"};'
  );
  return { run };
}

const fixture285 =
  'function duration(e,n,r,s,g){return{type:"system",subtype:"turn_duration",durationMs:e,messageCount:r,pendingBackgroundAgentCount:s,pendingWorkflowCount:g}}' +
  'function*query(e,n,r,s,g,h){let{fallbackModel:b}=x(h.model,h.fallbackModel),D=b===h.fallbackModel?h:{...h,fallbackModel:b},S=f=>f();let effort=S(()=>resolve(model,D.effortValue,{turnEffort:D.turnEffort,hookEffortValue:D.hookEffortValue}));yield effort}' +
  'class T{a(N,ye,E){N.transcript.apply({type:"append",messages:[duration(ye.durationMs,E,V(N.transcript.getSnapshot(),TE),ye.pendingBackgroundAgentCount,ye.pendingWorkflowCount)]})}b(D,N){this._requireHost().transcript.apply({type:"append",messages:[duration(D,N,V(this._requireHost().transcript.getSnapshot(),TE))]})}}' +
  'function render(m){let{message:l,addMargin:p,verb:h}=m,q="42s",W="5:17 PM";return{children:`${h} for ${q}${W?` \\xB7 done ${W}`:""}`}}';

// 2.1.288: options param destructured as `{modelFacts:h,...b}`, and the
// request-site call passes carriedEffort beside a counterfactual null call.
const fixture288 =
  'function duration(e,n,r,s,g){return{type:"system",subtype:"turn_duration",durationMs:e,messageCount:r,pendingBackgroundAgentCount:s,pendingWorkflowCount:g}}' +
  'async function*query(e,n,r,s,g,{modelFacts:h,...b}){let{fallbackModel:w}=x(b.model,b.fallbackModel),V=w===b.fallbackModel?b:{...b,fallbackModel:w},ye=f=>f();let Jr=ye(()=>carry(V)),sr=ye(()=>ow(Xe,V.effortValue,{turnEffort:V.turnEffort,hookEffortValue:V.hookEffortValue,carriedEffort:Jr})),As={withoutIt:ye(()=>ow(Xe,V.effortValue,{turnEffort:V.turnEffort,hookEffortValue:V.hookEffortValue,carriedEffort:null}))};yield sr}' +
  'class T{a(N,ye,E){N.transcript.apply({type:"append",messages:[duration(ye.durationMs,E,V(N.transcript.getSnapshot(),TE),ye.pendingBackgroundAgentCount,ye.pendingWorkflowCount)]})}}' +
  'function render(m){let{message:l,addMargin:p,verb:h}=m,q="42s",W="5:17 PM";return{children:`${h} for ${q}${W?` \\xB7 done ${W}`:""}`}}';

// 2.1.295: the duration factory dropped its budget parameter, so calls pass
// the duration, then the message count, then the optional pending counts.
const fixture295 =
  'function duration(e,n,r,s){return{type:"system",subtype:"turn_duration",durationMs:e,messageCount:n,pendingBackgroundAgentCount:r,pendingWorkflowCount:s}}' +
  'async function*query(e,n,r,s,g,{modelFacts:h,...b}){let{fallbackModel:w}=x(b.model,b.fallbackModel),V=w===b.fallbackModel?b:{...b,fallbackModel:w},ye=f=>f();let Jr=ye(()=>carry(V)),sr=ye(()=>ow(Xe,V.effortValue,{turnEffort:V.turnEffort,hookEffortValue:V.hookEffortValue,carriedEffort:Jr}));yield sr}' +
  'class T{a(N,Z){N.transcript.apply({type:"append",messages:[duration(Z.durationMs,V(N.transcript.getSnapshot(),TE),Z.pendingBackgroundAgentCount,Z.pendingWorkflowCount)]})}b(D){this._requireHost().transcript.apply({type:"append",messages:[duration(D,V(this._requireHost().transcript.getSnapshot(),TE))]})}}' +
  'function render(m){let{message:l,addMargin:p,verb:h}=m,q="42s",W="5:17 PM";return{children:`${h} for ${q}${W?` \\xB7 done ${W}`:""}`}}';

describe('router completed-turn status', () => {
  it('patches the 2.1.295 shape: four-parameter duration factory without a budget argument', () => {
    const patched = writeComplexityRouterTurnStatus(fixture295)!;
    expect(patched).not.toBeNull();
    expect(patched).toContain(
      'function duration(e,n,r,s,__tweakccRouterSnapshot){return{...(__tweakccRouterSnapshot?{tweakccRouter:__tweakccRouterSnapshot}:{}),type:"system"'
    );
    expect(patched).toContain(
      'duration(Z.durationMs,V(N.transcript.getSnapshot(),TE),Z.pendingBackgroundAgentCount,Z.pendingWorkflowCount,globalThis.__tweakccRouterSnapshotTurn?.(N.transcript.getSnapshot()))'
    );
    expect(patched).toContain(
      'duration(D,V(this._requireHost().transcript.getSnapshot(),TE),void 0,void 0,globalThis.__tweakccRouterSnapshotTurn?.(this._requireHost().transcript.getSnapshot()))'
    );
    expect(patched).toContain(
      'globalThis.__tweakccRouterRecordTurn?.(e,V,__tweakccResolved,'
    );
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  it('leaves calls that do not fit the factory alone', () => {
    const lookalike = 'function f(a,b){return xduration(a,V(b,TE))}';
    const patched = writeComplexityRouterTurnStatus(fixture295 + lookalike)!;
    expect(patched).toContain(lookalike);
    const noBudget = 'class U{c(D){duration(D,V(D.transcript,TE))}}';
    const patched288 = writeComplexityRouterTurnStatus(fixture288 + noBudget)!;
    expect(patched288).toContain(noBudget);
  });

  it('patches the 2.1.288 shape: rest-destructured options + carriedEffort request', () => {
    const patched = writeComplexityRouterTurnStatus(fixture288)!;
    expect(patched).not.toBeNull();
    expect(patched).toContain(
      'sr=ye(()=>{globalThis.__tweakccRouterResolution=void 0;let __tweakccResolved=ow(Xe,V.effortValue,{turnEffort:V.turnEffort,hookEffortValue:V.hookEffortValue,carriedEffort:Jr},V);globalThis.__tweakccRouterRecordTurn?.(e,V,__tweakccResolved,'
    );
    expect(patched).toContain(
      'withoutIt:ye(()=>ow(Xe,V.effortValue,{turnEffort:V.turnEffort,hookEffortValue:V.hookEffortValue,carriedEffort:null}))'
    );
    expect(patched).toContain(
      'globalThis.__tweakccRouterSnapshotTurn?.(N.transcript.getSnapshot())'
    );
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  it('patches the 2.1.285 shape: options alias + snapshot-getter message arg', () => {
    const patched = writeComplexityRouterTurnStatus(fixture285)!;
    expect(patched).not.toBeNull();
    expect(patched).toContain(
      'globalThis.__tweakccRouterRecordTurn?.(e,D,__tweakccResolved,'
    );
    expect(patched).toContain(
      'globalThis.__tweakccRouterSnapshotTurn?.(N.transcript.getSnapshot())'
    );
    expect(patched).toContain(
      'globalThis.__tweakccRouterSnapshotTurn?.(this._requireHost().transcript.getSnapshot())'
    );
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  it('persists confidence on its own turn across later decisions and resume', () => {
    const { run } = harness();
    run(
      'globalThis.__tweakccRouter={decision:{source:"jev",confidence:0.27}};globalThis.__tweakccRouterRecordTurn(messages,options,"medium",{effort:"medium"});var first=JSON.parse(JSON.stringify(globalThis.__tweakccRouterSnapshotTurn(messages)));messages.push({type:"user",uuid:"turn-2",message:{content:"next"}});globalThis.__tweakccRouter.decision.confidence=0.91;globalThis.__tweakccRouterRecordTurn(messages,options,"low",{effort:"low"});'
    );
    expect(run('first.confidence')).toBe(0.27);
    expect(
      run('globalThis.__tweakccRouterSnapshotTurn(messages).confidence')
    ).toBe(0.91);
  });

  it.each([0, 0.27, 0.995, 1])(
    'renders valid confidence %s including zero',
    confidence => {
      const patched = writeComplexityRouterTurnStatus(fixture)!;
      const context = vm.createContext({ confidence });
      vm.runInContext(patched, context);
      expect(
        vm.runInContext(
          'render({message:JSON.parse(JSON.stringify({tweakccRouter:{effort:"medium",source:"router",confidence}})),verb:"Worked"}).children',
          context
        )
      ).toContain(
        `Router → medium (confidence ${Math.round(confidence * 100)}%)`
      );
    }
  );

  it.each([undefined, null, -1, 2, NaN, Infinity, '0.5'])(
    'omits invalid or missing confidence %s',
    confidence => {
      const patched = writeComplexityRouterTurnStatus(fixture)!;
      const context = vm.createContext({ confidence });
      vm.runInContext(patched, context);
      expect(
        vm.runInContext(
          'render({message:{tweakccRouter:{effort:"low",source:"router",confidence}},verb:"Worked"}).children',
          context
        )
      ).not.toContain('confidence');
    }
  );

  it('does not attach confidence to a fallback or configured decision', () => {
    const { run } = harness();
    for (const source of ['fallback', 'configured']) {
      run(
        `globalThis.__tweakccRouter={decision:{source:"${source}",confidence:0.9}};globalThis.__tweakccRouterRecordTurn(messages,options,"medium",{effort:"medium"});`
      );
      expect(
        run('globalThis.__tweakccRouterSnapshotTurn(messages).confidence')
      ).toBeUndefined();
    }
  });

  it('snapshots actual effort, retaining historical values across later turns', () => {
    const { run } = harness();
    run(
      'globalThis.__tweakccRouterRecordTurn(messages,options,"high",{effort:"high"});var first=globalThis.__tweakccRouterSnapshotTurn(messages);messages.push({type:"user",uuid:"turn-2",message:{content:[{type:"text",text:"next"}]}});globalThis.__tweakccRouterRecordTurn(messages,options,"low",{effort:"low"});'
    );
    expect(run('first.effort')).toBe('high');
    expect(run('globalThis.__tweakccRouterSnapshotTurn(messages).effort')).toBe(
      'low'
    );
    expect(run('JSON.parse(JSON.stringify(first)).effort')).toBe('high');
  });

  it('ignores subagents and tool-result messages', () => {
    const { run } = harness();
    run(
      'globalThis.__tweakccRouterRecordTurn(messages,options,"medium",{effort:"medium"});messages.push({type:"user",uuid:"tool",message:{content:[{type:"tool_result",content:"result"}]}});globalThis.__tweakccRouterRecordTurn(messages,{...options,agentId:"agent"},"max",{effort:"max"});'
    );
    expect(run('globalThis.__tweakccRouterSnapshotTurn(messages).effort')).toBe(
      'medium'
    );
  });

  it('does not label native or explicitly overridden requests as routed', () => {
    const { run } = harness();
    expect(
      run('globalThis.__tweakccRouterSnapshotTurn(messages)')
    ).toBeUndefined();
    run(
      'globalThis.__tweakccRouterRecordTurn(messages,options,"high",{effort:"high"});globalThis.__tweakccRouterRecordTurn(messages,options,"medium",undefined);'
    );
    expect(
      run('globalThis.__tweakccRouterSnapshotTurn(messages)')
    ).toBeUndefined();
  });

  it('records fallback provenance and returns independent snapshot copies', () => {
    const { run } = harness();
    run(
      'globalThis.__tweakccRouter={decision:{source:"fallback"}};globalThis.__tweakccRouterRecordTurn(messages,options,"medium",{effort:"medium"});var first=globalThis.__tweakccRouterSnapshotTurn(messages);first.effort="max";'
    );
    expect(run('globalThis.__tweakccRouterSnapshotTurn(messages).source')).toBe(
      'fallback'
    );
    expect(run('globalThis.__tweakccRouterSnapshotTurn(messages).effort')).toBe(
      'medium'
    );
  });

  it.each([
    ['fallback', 'fallback'],
    ['pinned', 'pinned'],
    ['omitted', 'incomplete input'],
  ])('shows %s decision provenance', (source, label) => {
    const patched = writeComplexityRouterTurnStatus(fixture);
    const context = vm.createContext({ source });
    vm.runInContext(patched!, context);
    const rendered = vm.runInContext(
      'render({message:{tweakccRouter:{effort:"medium",source}},verb:"Worked"}).children',
      context
    );
    expect(rendered).toContain(`Router → medium (${label})`);
  });

  it('patches capture, persisted message, and done-line rendering together', () => {
    const patched = writeComplexityRouterTurnStatus(fixture);
    expect(patched).not.toBeNull();
    expect(writeComplexityRouterTurnStatus(patched!)).toBe(patched);
    const context = vm.createContext({});
    vm.runInContext(patched!, context);
    const run = (source: string) => vm.runInContext(source, context);
    run(
      'function resolve(model,effort,overrides){if(overrides.turnEffort)return overrides.turnEffort;globalThis.__tweakccRouterResolution={effort:"medium"};return "medium"};var messages=[{type:"user",uuid:"one",message:{content:"hello"}}];query(messages,null,null,null,null,{model:"opus",querySource:"repl_main_thread"}).next();var snapshot=globalThis.__tweakccRouterSnapshotTurn(messages);var message=duration(42000,null,1,null,null,snapshot);'
    );
    expect(run('render({message,verb:"Hyperspaced"}).children')).toBe(
      'Hyperspaced for 42s · done 5:17 PM · Router → medium'
    );
    run(
      'query(messages,null,null,null,null,{model:"opus",querySource:"repl_main_thread",turnEffort:"high"}).next();'
    );
    expect(
      run('globalThis.__tweakccRouterSnapshotTurn(messages)')
    ).toBeUndefined();
    expect(run('render({message,verb:"Hyperspaced"}).children')).toContain(
      'Router → medium'
    );
    expect(
      run('render({message:{},verb:"Hyperspaced"}).children')
    ).not.toContain('Router');
  });

  it('matches the installed pristine native status and main-query scopes', () => {
    const pristine = path.join(
      os.homedir(),
      '.tweakcc/native-claudejs-orig.js'
    );
    if (!fs.existsSync(pristine)) return;
    const patched = writeComplexityRouterTurnStatus(
      fs.readFileSync(pristine, 'utf8')
    );
    expect(patched).not.toBeNull();
    // Minified names change every build (the options arg was `h` through
    // 2.1.284 and is the `D` alias in 2.1.285), so assert the call's shape.
    expect(patched).toMatch(
      /globalThis\.__tweakccRouterRecordTurn\?\.\([$\w]+,[$\w]+,__tweakccResolved,/
    );
    expect(
      patched?.match(/globalThis\.__tweakccRouterSnapshotTurn\?\.\(/g)
    ).toHaveLength(3);
  });
});
