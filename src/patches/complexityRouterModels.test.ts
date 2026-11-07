import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../defaultSettings';
import { writeFablePlan } from './fablePlan';
import { writeComplexityRouterModels } from './complexityRouterModels';

const fixture = [
  'class Selection{#e;#n;overrideMainLoopModel(e){this.#e=e}replaceInitialMainLoopModel(e){this.#n=e}}var modelSelection=new Selection;',
  'var aliases=["sonnet","opus","haiku","fable","opusplan"],other=["sonnet","opus","haiku"];',
  'function resolve(e){let n=e.trim(),r=n.toLowerCase();if(valid(r))switch(r){case"opus":return"claude-opus-5-5";case"fable":return"claude-fable-5-1"}return n}',
  'function defaults(e){let n=provider();switch(e){case"opus":return opus(n);default:return null}}',
  'function selected(){let e=current();if(e!==void 0)return identity(e,"explicit");return fallback()}',
  'function picker(e=!1,n=null){let r=new Set,s=rows(e,n).filter((L)=>{if(L.value===null)return!0;if(r.has(L.value))return!1;r.add(L.value);return!0});return s}',
  'var adjust=callback((dir)=>{let selected=highlight(),row=options.find((x)=>x.value===selected);if(row===void 0||row.disabled===!0)return;let state=effort(selected);if(!state.supportsEffort)return;changed()});',
  'function display(){return focused!==void 0&&!hidden&&el(Box,{marginBottom:1,flexDirection:"column",children:supported?"manual":el(Text,{color:"subtle",children:[el(Icon,{effort:void 0})," Effort not supported"]})})}',
  'function commit(value){let model=resolve(value),level=getLevel(),stored=getStored(),picked=model&&level!==void 0&&level!=="ultracode"?clamp(level,model):level;event("tengu_model_command_menu_effort",{});if(value===DEFAULT){apply(null,picked);return}apply(value,picked)}',
].join('');

// CC 2.1.284 dropped the ultracode guard: ultracode became a session flag.
const fixture284 = fixture.replace('&&level!=="ultracode"', '');

// CC 2.1.312 split the unsupported-effort label into `" ","Effort..."` and
// added `dimColor:!1`.
const fixture312 = fixture284.replace(
  'el(Text,{color:"subtle",children:[el(Icon,{effort:void 0})," Effort not supported"]})',
  'el(Text,{color:"subtle",dimColor:!1,children:[el(Icon,{effort:void 0})," ","Effort not supported"]})'
);

// CC 2.1.319 guards the adjust handler and the commit against the "more
// models" row and dims the unsupported-effort label.
const fixture319 = fixture312
  .replace(
    'if(row===void 0||row.disabled===!0)return;',
    'if(row===void 0||row.disabled===!0||row.value===MORE)return;'
  )
  .replace(
    'function commit(value){',
    'function commit(value){if(value===MORE)return;'
  )
  .replace(
    'el(Text,{color:"subtle",dimColor:!1,children:',
    'el(Text,{dimColor:!0,children:'
  );

function harness(source = fixture) {
  const context = vm.createContext({
    available: [] as { value: string; disabled?: boolean }[],
    selection: 'opus',
    focus: 'opus',
    focused: 'opusrouter',
    hidden: false,
    supported: true,
    applied: [] as unknown[],
    adjustments: 0,
    synchronizations: 0,
    queueMicrotask,
    Box: 'box',
    Text: 'text',
    Icon: 'icon',
    el: (_tag: unknown, props: unknown) => props,
    DEFAULT: 'default',
    MORE: 'more',
  });
  const result = writeComplexityRouterModels(source);
  expect(result).not.toBeNull();
  vm.runInContext(
    'function valid(x){return aliases.includes(x)}function current(){return selection}function identity(x){return x}function fallback(){return "opus"}' +
      'function rows(){return available}function callback(x){return x}function highlight(){return focus}function effort(){return{supportsEffort:true}}' +
      'function changed(){adjustments++}function getLevel(){return "max"}function getStored(){return true}function clamp(x){return x}function event(){}' +
      'function apply(x,e){selection=x;applied=[x,e];modelSelection.overrideMainLoopModel(x)}function provider(){}function opus(){return "claude-opus-5-5"}' +
      'globalThis.__tweakccRouterSyncSelection=()=>synchronizations++;globalThis.__tweakccRouterState=()=>({effort:"high"});' +
      result +
      ';var options=[{value:"opus"},{value:"opusrouter"},{value:"fablerouter"}];',
    context
  );
  return { context, result: result! };
}

describe('effort router model aliases', () => {
  it('resolves only explicit verified versions and reads selection live', () => {
    const { context } = harness();
    expect(vm.runInContext('resolve("opusrouter")', context)).toBe(
      'claude-opus-5-5'
    );
    expect(vm.runInContext('defaults("fablerouter")', context)).toBe(
      'claude-fable-5-1'
    );
    expect(
      vm.runInContext('globalThis.__tweakccRouterSelectedModel()', context)
    ).toBeNull();
    context.selection = 'fablerouter';
    expect(
      vm.runInContext('globalThis.__tweakccRouterSelectedModel()', context)
    ).toBe('claude-fable-5-1');
    context.selection = 'fableplan';
    expect(
      vm.runInContext('globalThis.__tweakccRouterSelectedModel()', context)
    ).toBeNull();
  });

  it('offers aliases only for enabled underlying versions after native filtering', () => {
    const { context } = harness();
    context.available = [
      { value: 'opus' },
      { value: 'fable', disabled: true },
      { value: 'claude-opus-5' },
      { value: 'fablerouter' },
    ];
    expect(vm.runInContext('picker().map(x=>x.value)', context)).toEqual([
      'opus',
      'opusrouter',
      'fable',
      'claude-opus-5',
    ]);
    context.available = [
      { value: null },
      { value: 'opus' },
      { value: 'fable' },
      { value: 'haiku' },
    ];
    expect(vm.runInContext('picker().map(x=>x.value)', context)).toEqual([
      null,
      'opus',
      'opusrouter',
      'fable',
      'fablerouter',
      'haiku',
    ]);
    context.available = [{ value: 'claude-fable-5-1' }];
    expect(vm.runInContext('picker().map(x=>x.value)', context)).toEqual([
      'claude-fable-5-1',
      'fablerouter',
    ]);
    context.available = [{ value: 'claude-opus-5-5[1m]' }];
    expect(vm.runInContext('picker().map(x=>x.value)', context)).toEqual([
      'claude-opus-5-5[1m]',
    ]);
  });

  it('disables arrows, clears a manual selection and synchronizes all switches', async () => {
    const { context } = harness();
    context.focus = 'opusrouter';
    vm.runInContext('adjust("right")', context);
    expect(context.adjustments).toBe(0);
    context.focus = 'opus';
    vm.runInContext('adjust("right")', context);
    expect(context.adjustments).toBe(1);
    expect(vm.runInContext('display().children', context)).toMatchObject({
      children: 'Automatic effort · currently high',
    });
    vm.runInContext('commit("fablerouter")', context);
    expect(context.applied).toEqual(['fablerouter', undefined]);
    await Promise.resolve();
    expect(context.synchronizations).toBe(1);
    vm.runInContext('commit("opus")', context);
    expect(context.applied).toEqual(['opus', 'max']);
    await Promise.resolve();
    expect(context.synchronizations).toBe(2);
    vm.runInContext(
      'modelSelection.replaceInitialMainLoopModel("haiku")',
      context
    );
    await Promise.resolve();
    expect(context.synchronizations).toBe(3);
  });

  it('clears the effort on the CC 2.1.284 commit without the ultracode guard', () => {
    expect(fixture284).not.toContain('ultracode');
    const { context, result } = harness(fixture284);
    expect(result).toContain(
      'function commit(value){if((value==="opusrouter"||value==="fablerouter")){apply(value,void 0);return}let model=resolve(value)'
    );
    vm.runInContext('commit("opusrouter")', context);
    expect(context.applied).toEqual(['opusrouter', undefined]);
    vm.runInContext('commit("opus")', context);
    expect(context.applied).toEqual(['opus', 'max']);
    expect(writeComplexityRouterModels(result)).toBe(result);
  });

  it('shows automatic effort with the CC 2.1.312 unsupported-effort label', () => {
    expect(fixture312).toContain(
      'dimColor:!1,children:[el(Icon,{effort:void 0})," ","Effort not supported"'
    );
    const { context, result } = harness(fixture312);
    expect(vm.runInContext('display().children', context)).toMatchObject({
      color: 'subtle',
      children: 'Automatic effort · currently high',
    });
    context.focused = 'opus';
    expect(vm.runInContext('display().children', context)).toBe('manual');
    expect(writeComplexityRouterModels(result)).toBe(result);
  });

  it('applies against the CC 2.1.319 picker with a more-models row', () => {
    expect(fixture319).toContain('row.value===MORE)return;');
    expect(fixture319).toContain(
      'function commit(value){if(value===MORE)return;'
    );
    const { context, result } = harness(fixture319);
    expect(result).toContain(
      'row.value===MORE)return;if((selected==="opusrouter"||selected==="fablerouter"))return;let state'
    );
    expect(result).toContain(
      'function commit(value){if(value===MORE)return;if((value==="opusrouter"||value==="fablerouter")){apply(value,void 0);return}let model'
    );
    context.focus = 'opusrouter';
    vm.runInContext('adjust("right")', context);
    expect(context.adjustments).toBe(0);
    expect(vm.runInContext('display().children', context)).toMatchObject({
      color: 'subtle',
      children: 'Automatic effort · currently high',
    });
    vm.runInContext('commit("fablerouter")', context);
    expect(context.applied).toEqual(['fablerouter', undefined]);
    vm.runInContext('commit("more")', context);
    expect(context.applied).toEqual(['fablerouter', undefined]);
    vm.runInContext('commit("opus")', context);
    expect(context.applied).toEqual(['opus', 'max']);
    expect(writeComplexityRouterModels(result)).toBe(result);
  });

  it('does not confuse runtime getter comparisons with alias installation', () => {
    const source =
      'function active(){return typeof globalThis.__tweakccRouterSelectedModel==="function"?globalThis.__tweakccRouterSelectedModel():null}' +
      fixture;
    const result = writeComplexityRouterModels(source);
    expect(result).not.toBeNull();
    expect(result).not.toBe(source);
    expect(result).toContain(
      'globalThis.__tweakccRouterSelectedModel=function('
    );
    expect(result).toContain('case"opusrouter":return"claude-opus-5-5";');
  });

  it('reaches the alias resolver from a picker in another chunk', () => {
    // CC 2.1.311 code-splits the picker away from the resolver; the picker
    // must not name the resolver's minified identifier.
    const result = writeComplexityRouterModels(fixture)!;
    const at = result.indexOf('function picker(');
    const pickerChunk = result.slice(at, result.indexOf('var adjust=', at));
    expect(pickerChunk).not.toMatch(/(?<![$\w.])resolve\(/);
    const resolverChunk = result
      .slice(result.indexOf('globalThis.__tweakccRouterAliasModel='))
      .split('function defaults(')[0];
    const resolverScope = vm.createContext({});
    vm.runInContext(
      'function valid(x){return x==="opus"}' + resolverChunk,
      resolverScope
    );
    const pickerScope = vm.createContext({
      available: [{ value: 'opus' }],
      __tweakccRouterAliasModel: resolverScope.__tweakccRouterAliasModel,
    });
    vm.runInContext(
      'function rows(){return available}' + pickerChunk,
      pickerScope
    );
    expect(vm.runInContext('typeof resolve', pickerScope)).toBe('undefined');
    expect(vm.runInContext('picker().map(x=>x.value)', pickerScope)).toEqual([
      'opus',
      'opusrouter',
    ]);
  });

  it('is idempotent and leaves unsupported older builds alone', () => {
    const { result } = harness();
    expect([...result].every(char => char.charCodeAt(0) <= 127)).toBe(true);
    expect(writeComplexityRouterModels(result)).toBe(result);
    expect(writeComplexityRouterModels('old bundle')).toBe('old bundle');
  });
});

const pristine = path.join(os.homedir(), '.tweakcc/native-claudejs-orig.js');
describe.skipIf(!fs.existsSync(pristine))(
  'installed pristine model shapes',
  () => {
    it.each([false, true])(
      'applies with Fable Plan enabled=%s',
      enabled => {
        const original = fs.readFileSync(pristine, 'utf8');
        const input = enabled
          ? writeFablePlan(original, {
              ...DEFAULT_SETTINGS.fablePlan,
              enabled: true,
            })
          : original;
        expect(input).not.toBeNull();
        const result = writeComplexityRouterModels(input!);
        expect(result).not.toBeNull();
        expect(result).not.toBe(input);
        expect(result).toContain('globalThis.__tweakccRouterSelectedModel=');
        expect(result!.split('import.meta.require').length).toBe(
          input!.split('import.meta.require').length
        );
      },
      30000
    );
  }
);
