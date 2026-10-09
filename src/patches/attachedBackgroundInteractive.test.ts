import { describe, it, expect, vi } from 'vitest';
import { writeAttachedBackgroundInteractive } from './attachedBackgroundInteractive';

// Verbatim shapes from the CC 2.1.294 bundle, one bundle module each, joined
// the way the native extractor marks module boundaries.
const mark = (n: number, name: string) =>
  `\n/*@@TWEAKCC_MODULE:${n}:/$bunfs/root/${name}.js@@*/\n`;

const DEFINING =
  'import{Gc,n_,Ou}from"/$bunfs/root/chunk-other.js";' +
  'function VB(){let e=a.CLAUDE_CODE_SESSION_KIND;if(e==="bg"||e==="daemon"||e==="daemon-worker")return e;return}' +
  'function Lt(){return VB()==="bg"}function Ym(){return Gc()||Lt()||n_()!==void 0}' +
  'function Vu(){return Lt()&&!Ou()}function Oc(){return Lt()||db()!==null}' +
  'export{VB,Lt,Ym,Vu,Oc};';

const PROPOSE_GOAL =
  'import{Lt,T}from"/$bunfs/root/chunk-9dpf1mt6.js";' +
  'function Hfn(){return T("tengu_propose_goal",!1)}' +
  'var K={isEnabled(){if(ve()||$n())return!1;if(Lt())return!1;if(!Hfn())return!1;let e=eat();if(e==="disabled")return!1;return E(e),!0},' +
  'create(e){return{async call({condition:n,ask_user:w}){if(e.agentId)throw Error("ProposeGoal cannot be used in agent contexts");' +
  'if(ve()||$n()||Lt())throw p("goal_propose","session_shape"),Error("Goal proposals are only available in interactive local sessions.")}}}};';

const AUTO_RESUME =
  'import{fp}from"/$bunfs/root/chunk-7hfane9f.js";import{Lt,T}from"/$bunfs/root/chunk-9dpf1mt6.js";' +
  'function bBt(){return fx("autoContinueAtUsageLimit")[0]}var u="tengu_marble_heron";' +
  'function f5n(){let e=n();return o(e)?e:{}}function SBt(){return fp()&&!Lt()&&!Dt()}function KHo(){return SBt()&&LPe()}' +
  'export{bBt,SBt,KHo};';

const AUTO_CONTINUE =
  'import{Lt}from"/$bunfs/root/chunk-9dpf1mt6.js";' +
  'var o="Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete.";' +
  'function yft(){return _t()&&Dn()?.billingType!=="usage_based"&&bl()&&fp()&&!$n()&&!Lt()}' +
  'function Boe(e){return yft()&&nF(e)&&e.rateLimitType==="five_hour"}export{yft,Boe};';

// Inner scopes of this module bind `Vu` as a local, as in the real one.
const OUTSIDE_READ =
  'import{Lt,ce}from"/$bunfs/root/chunk-9dpf1mt6.js";' +
  'function f(Vu){return Vu.type==="thinking"}' +
  'function iln(e,n,r,s){if(s.options.isNonInteractiveSession)return!1;if(Lt()||v0e())return!1;if(!Rn("userSettings"))return!1;' +
  'return!s.session.outsideReadPrompt.isOpenElsewhere(s.toolUseId)&&!ce().hasSeenAutoModeOutsideReadPrompt}' +
  'function J(){if(Lt())return;return a.CLAUDE_JOB_DIR}export{iln,J};';

const WORKFLOW =
  'import{Lt}from"/$bunfs/root/chunk-9dpf1mt6.js";' +
  'function d(e,o){if(e!==_u)return!1;if(o.options.isNonInteractiveSession)return!1;if(de(o).shouldAvoidPermissionPrompts)return!1;' +
  'if(Lt())return!1;if(v0e())return!1;if(ZT(cYt(o),o.options.mainLoopModel))return!1;return!o.session.workflowUsageConsent.isGranted()&&!mbr()}' +
  'export{d as workflowNeedsUsageConsentPrompt};';

// The session engine's tool pool cache and its key comparison.
const TOOL_POOL =
  'class Ae{toolPoolCache=null;computeToolPool(h,E,D){let L={toolPermissionContext:h.toolPermissionContext,mcpTools:h.mcp.tools,' +
  'githubRepo:uQt(),workspaceRestricted:AR(),waitForMcpServersDeclared:xWe()},Q=this.toolPoolCache;if(Q!==null&&hbt(Q.key,L))return Q.result;' +
  'return this.toolPoolCache={key:L,result:ENt(h)},this.toolPoolCache.result}}' +
  'function hbt(h,E){return h.toolPermissionContext===E.toolPermissionContext&&h.mcpTools===E.mcpTools&&h.githubRepo===E.githubRepo' +
  '&&h.workspaceRestricted===E.workspaceRestricted&&h.waitForMcpServersDeclared===E.waitForMcpServersDeclared}';

const FIXTURE =
  mark(135, 'chunk-9dpf1mt6') +
  DEFINING +
  mark(1634, 'chunk-nx2hg68y') +
  PROPOSE_GOAL +
  mark(474, 'chunk-0aph037z') +
  AUTO_RESUME +
  mark(933, 'chunk-hdbr3192') +
  AUTO_CONTINUE +
  mark(390, 'chunk-pzq6n5xh') +
  OUTSIDE_READ +
  mark(1206, 'chunk-vpjjvfwn') +
  WORKFLOW +
  mark(1700, 'chunk-8kvgr3rw') +
  TOOL_POOL;

const BRIDGE = 'globalThis.__tweakccUnattendedBg';

describe('writeAttachedBackgroundInteractive', () => {
  it('keys the tool pool cache on the unattended predicate', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE)!;
    expect(out).toContain(
      `waitForMcpServersDeclared:xWe(),unattendedBg:${BRIDGE}()},Q=this.toolPoolCache;`
    );
    expect(out).toContain(
      '&&h.waitForMcpServersDeclared===E.waitForMcpServersDeclared&&h.unattendedBg===E.unattendedBg}'
    );
  });

  it('assembles the pool again when the predicate changes, and only then', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE)!;
    const engine = out.slice(out.indexOf('class Ae{'));
    let built = 0;
    let unattended = true;
    const g = globalThis as Record<string, unknown>;
    g.__tweakccUnattendedBg = () => unattended;
    const make = new Function(
      'ENt',
      'uQt',
      'AR',
      'xWe',
      `${engine};return Ae;`
    );
    const Engine = make(
      () => ({ n: ++built }),
      () => 'repo',
      () => false,
      () => false
    );
    const engineInstance = new Engine();
    const state = { toolPermissionContext: {}, mcp: { tools: [] } };
    engineInstance.computeToolPool(state);
    engineInstance.computeToolPool(state);
    expect(built).toBe(1);
    unattended = false;
    engineInstance.computeToolPool(state);
    expect(built).toBe(2);
    engineInstance.computeToolPool(state);
    expect(built).toBe(2);
    delete g.__tweakccUnattendedBg;
  });

  it('moves each background-only gate to the unattended predicate', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE);
    expect(out).not.toBeNull();
    expect(out).toContain(
      `if(ve()||$n())return!1;if(${BRIDGE}())return!1;if(!Hfn())return!1;`
    );
    expect(out).toContain(
      `if(ve()||$n()||${BRIDGE}())throw p("goal_propose","session_shape")`
    );
    expect(out).toContain(`function SBt(){return fp()&&!${BRIDGE}()&&!Dt()}`);
    expect(out).toContain(`&&!$n()&&!${BRIDGE}()}function Boe(`);
    expect(out).toContain(
      `if(${BRIDGE}()||v0e())return!1;if(!Rn("userSettings"))`
    );
    expect(out).toContain(`if(${BRIDGE}())return!1;if(v0e())return!1;if(ZT(`);
  });

  it('forces the tengu_propose_goal flag on', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE);
    expect(out).toContain(
      'function Hfn(){return !0;return T("tengu_propose_goal",!1)}'
    );
  });

  it('publishes the unattended predicate beside its definition, once', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE)!;
    expect(out).toContain(
      `function Vu(){return Lt()&&!Ou()}${BRIDGE}=Vu;function Oc(){`
    );
    expect(out.split(`${BRIDGE}=`).length - 1).toBe(1);
  });

  it('leaves the import lists alone', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE)!;
    expect(out.match(/import\{[^}]*\}/g)).toEqual(
      FIXTURE.match(/import\{[^}]*\}/g)
    );
  });

  it('leaves every other background test and the predicates alone', () => {
    const out = writeAttachedBackgroundInteractive(FIXTURE)!;
    expect(out).toContain(
      'function Lt(){return VB()==="bg"}function Ym(){return Gc()||Lt()||n_()!==void 0}'
    );
    expect(out).toContain(
      'function J(){if(Lt())return;return a.CLAUDE_JOB_DIR}'
    );
    expect(out).toContain('function f(Vu){return Vu.type==="thinking"}');
  });

  it('is a no-op on its own output', () => {
    const once = writeAttachedBackgroundInteractive(FIXTURE)!;
    expect(writeAttachedBackgroundInteractive(once)).toBe(once);
  });

  it('fails when a gate is missing rather than patching part of the set', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = writeAttachedBackgroundInteractive(
      FIXTURE.replace('workflowUsageConsent', 'somethingElse')
    );
    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'patch: attachedBackgroundInteractive: failed to find the workflow usage consent prompt'
    );
    errorSpy.mockRestore();
  });

  it('fails when the unattended predicate is not beside the background one', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = writeAttachedBackgroundInteractive(
      FIXTURE.replace('function Vu(){return Lt()&&!Ou()}', '')
    );
    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'patch: attachedBackgroundInteractive: failed to find the unattended background predicate'
    );
    errorSpy.mockRestore();
  });
});
