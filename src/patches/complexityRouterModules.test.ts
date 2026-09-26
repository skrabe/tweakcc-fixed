import vm from 'node:vm';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../defaultSettings';
import { writeComplexityRouter } from './complexityRouter';
import { clearRequireFuncNameCache } from './helpers';

const modules = [
  {
    path: '/bundle/haiku.js',
    source:
      'async function gB({systemPrompt:e=vc([]),userPrompt:t,outputFormat:n,signal:r,options:o}){' +
      'return(await qWn([Ln({content:e.map((i)=>({type:"text",text:i}))}),Ln({content:t})],async()=>{' +
      'let i=[Ln({content:t})];return[await DWe({messages:i,systemPrompt:e,thinkingConfig:{type:"disabled"},' +
      'tools:[],signal:r,options:{...o,stickyBetas:o.stickyBetas??o0(WH()),agentContext:o.agentContext,' +
      'model:HR(),enablePromptCaching:o.enablePromptCaching??!1,outputFormat:n,' +
      'async getToolPermissionContext(){return WM()}}})]}))[0]}' +
      'function vc(x){return x}function Ln(x){return x}async function qWn(x,f){return f()}' +
      'function DWe(x){return globalThis.sidecall(x)}function HR(){return "claude-opus-5-5"}' +
      'function o0(){return []}function WH(){}',
  },
  {
    path: '/bundle/context.js',
    source:
      'function km(){return{agentType:"main",agentId:xt()}}function xt(){return "isolated-agent-context"}',
  },
  {
    path: '/bundle/resolver.js',
    source:
      'function XQ(e,t){if(!FR(e))return;let n=fUe(e),r=Tbn(e),o=mUe();' +
      'if(o===null)return n?r:void 0;let s=o??(n?r:void 0)??t??r;' +
      'if(s==="max"&&!dUe(e))return"high";if(s==="xhigh"&&!GRe(e))return"high";return s}' +
      'function FR(){return true}function fUe(){return false}function Tbn(){return "medium"}' +
      'function mUe(){}function dUe(){return true}function GRe(){return true}' +
      'globalThis.resolveEffort=XQ;',
  },
  {
    path: '/bundle/submit.js',
    source:
      'async function hMm(e,t,n,r){let E=null,k=Sg(r.options.mainLoopModel),w=e;if(typeof e==="string")E=e;' +
      'if(E===null&&t!=="prompt")throw Error(`Mode: ${t} requires a string input.`);return E}' +
      'function Sg(x){return x}globalThis.submit=hMm;',
  },
  {
    path: '/bundle/round.js',
    source:
      'function round(g,ctx,Te,ye){let Qn;if(g.gates.emitToolUseSummaries&&ye.length>0&&!ctx.abortController.signal.aborted&&!ctx.agentId){let Et=Te.at(-1);globalThis.toolSummaryReached=true}}' +
      'globalThis.round=round;',
  },
  {
    path: '/bundle/lifecycle.js',
    source:
      'function summarize(){let text="Speculative summary";return{ok:!0,summaryText:text,messages:[]}}' +
      'const controller={handleRestoreMessage(message,source){return this===controller&&source==="message_selector"?message.timestamp:null}};' +
      'const handlers={onRestoreMessage:(message)=>controller.handleRestoreMessage(message,"message_selector")};' +
      'globalThis.speculativeSummary=summarize;globalThis.restore=handlers.onRestoreMessage;',
  },
];

function harness(provider: 'jev' | 'haiku', loadHelpers = true) {
  const source = modules
    .map((m, index) => `/*@@TWEAKCC_MODULE:${index}:${m.path}@@*/${m.source}`)
    .join('\n');
  const patched = writeComplexityRouter(source, {
    ...DEFAULT_SETTINGS.complexityRouter,
    enabled: true,
    provider,
    pinPerTask: false,
  });
  expect(patched).toBeTruthy();
  expect(patched).not.toBe(source);
  expect(patched).not.toContain('import.meta.require');
  expect(patched).toContain('process.getBuiltinModule');
  const sidecall = vi.fn().mockResolvedValue({
    summary: 'Parser migration across four packages; tests incomplete.',
    level: 3,
  });
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          answers: {
            effort: {
              type: 'choice',
              choice: '3',
              confidence: 0.95,
              probabilities: { '0': 0.01, '1': 0.01, '2': 0.01, '3': 0.97 },
            },
          },
        })
      )
  );
  const loaded = new Set<string>();
  const bodies = new Map<string, string>();
  for (const match of patched!.matchAll(
    /\/\*@@TWEAKCC_MODULE:\d+:([^\n]+?)@@\*\/([\s\S]*?)(?=\/\*@@TWEAKCC_MODULE:|$)/g
  )) {
    bodies.set(match[1], match[2]);
  }
  const context = vm.createContext({
    __tweakccRouterSelectedModel: () => 'opus',
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    sidecall,
    fetch,
    process: {
      env: { TYPESAFE_API_KEY: 'test-secret' },
      stderr: { write: vi.fn() },
    },
  });
  const load = (id: string): unknown => {
    if (id === 'path') return path;
    if (id === 'os') return { homedir: () => '/unused-test-home' };
    if (id === 'fs')
      return {
        promises: {
          mkdir: async () => {
            throw new Error('disabled');
          },
        },
      };
    if (!bodies.has(id)) throw new Error(`Unexpected module: ${id}`);
    if (!loaded.has(id)) {
      loaded.add(id);
      vm.runInContext(`(function(){${bodies.get(id)!}\n})()`, context);
    }
    return {};
  };
  context.process.getBuiltinModule = load;
  if (loadHelpers) {
    load('/bundle/haiku.js');
    load('/bundle/context.js');
  }
  load('/bundle/resolver.js');
  load('/bundle/submit.js');
  load('/bundle/round.js');
  load('/bundle/lifecycle.js');
  const turn = {
    options: { mainLoopModel: 'opus' },
    messages: [],
    session: { id: 'test-session' },
    abortController: new AbortController(),
  };
  return { context, loaded, fetch, sidecall, turn };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(clearRequireFuncNameCache);

describe('effort router across isolated Bun modules', () => {
  it.each(['jev', 'haiku'] as const)(
    '%s submission routes across module boundaries using registered helpers',
    async provider => {
      const h = harness(provider);
      expect(h.loaded.has('/bundle/haiku.js')).toBe(true);
      expect(h.loaded.has('/bundle/context.js')).toBe(true);
      expect(h.context.gB).toBeUndefined();
      expect(h.context.km).toBeUndefined();
      await h.context.submit(
        'Migrate parser across four packages',
        'prompt',
        null,
        h.turn
      );
      await flush();
      expect(h.context.resolveEffort('opus', 'medium')).toBe('max');
      expect(h.loaded.has('/bundle/haiku.js')).toBe(true);
      expect(h.loaded.has('/bundle/context.js')).toBe(true);
      expect(h.sidecall).toHaveBeenCalled();
      expect(h.sidecall.mock.calls[0][0].options.model).toBe(
        'claude-haiku-4-5'
      );
      expect(h.sidecall.mock.calls[0][0].options.agentContext).toEqual({
        agentType: 'main',
        agentId: 'isolated-agent-context',
      });
      expect(h.context.gB).toBeUndefined();
      expect(h.context.km).toBeUndefined();
      expect(h.fetch).toHaveBeenCalledTimes(provider === 'jev' ? 1 : 0);
    }
  );

  it('preserves the native model selection for unrelated sidecalls', async () => {
    const h = harness('jev');
    await h.context.__tweakccRouterHaiku({
      systemPrompt: [],
      userPrompt: 'Unrelated helper request',
      options: { querySource: 'other_feature', agentContext: {} },
    });
    expect(h.sidecall.mock.calls[0][0].options.model).toBe('claude-opus-5-5');
  });

  it('keeps Jev routing available when a summary helper has not registered', async () => {
    const h = harness('jev', false);
    await h.context.submit('Review parser correctness', 'prompt', null, h.turn);
    await flush();
    expect(h.context.resolveEffort('opus', 'medium')).toBe('max');
    expect(h.sidecall).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.context.__tweakccRouter.summaryBusy).toBe(false);
  });

  it('captures a pure-text assistant round with tool summaries disabled without rerouting', async () => {
    const h = harness('jev');
    await h.context.submit(
      'Explain the parser migration',
      'prompt',
      null,
      h.turn
    );
    await flush();
    const previousCalls = h.sidecall.mock.calls.length;
    h.context.round(
      { gates: { emitToolUseSummaries: false } },
      h.turn,
      [
        {
          uuid: 'assistant-text-only',
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'Migration has four stages and requires regression checks.',
              },
            ],
          },
        },
      ],
      []
    );
    await flush();
    expect(h.context.toolSummaryReached).toBeUndefined();
    expect(h.sidecall.mock.calls.length).toBeGreaterThan(previousCalls);
    expect(h.sidecall.mock.calls.at(-1)![0].messages[0].content).toContain(
      'Migration has four stages'
    );
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores speculative compaction and invalidates member-method rewinds across modules', async () => {
    const h = harness('jev');
    await h.context.submit('Review parser correctness', 'prompt', null, h.turn);
    await flush();
    const state = h.context.__tweakccRouter;
    const generation = state.generation;
    expect(h.context.speculativeSummary().ok).toBe(true);
    expect(state.generation).toBe(generation);
    expect(state.pendingCompaction).toBeUndefined();
    expect(h.context.restore({ timestamp: 1234 })).toBe(1234);
    expect(state.pendingRewindCut).toBe(1234);
    expect(state.generation).toBeGreaterThan(generation);
  });
});
