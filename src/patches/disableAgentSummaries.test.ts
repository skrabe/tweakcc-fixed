import { describe, it, expect, vi } from 'vitest';
import { writeDisableAgentSummaries } from './disableAgentSummaries';

// Trimmed from CC 2.1.312: the summarizer's timer callback, its single
// scheduler, and the stop handle that must keep working.
const FIXTURE =
  'function Ui(e,n,s,y,r,b={}){let j=!1,de=!1,ue,Pe=0,R={calls:0};' +
  'async function Me(){if(j)return;let we=!1;t(`[AgentSummary] Timer fired for agent ${n}`);' +
  'try{if(de)return;send()}finally{if(!j)xe()}}' +
  'function fe(we){return 30000}' +
  'function xe(){if(j)return;let we=fe(R.calls),Re=Math.min(Pe<we?we-Pe:we,Pi);Pe+=Re,ue=setTimeout(Me,Re)}' +
  'function Le(){if(j)return;if(t(`[AgentSummary] Stopping summarization for ${e}`),j=!0,ue)clearTimeout(ue),ue=null}' +
  'return xe(),{stop:Le}}';

// Trimmed from CC 2.1.316: the scheduler's delay became an expression.
const FIXTURE_316 =
  'function Di(e,n,s,y,r,b={}){let v=b.waitsMs?.[0]??hu,j=null,ie=!1,he=!1,de=null,Te=0;' +
  'async function Ee(){if(ie)return;let je=!1;t(`[AgentSummary] Timer fired for agent ${n}`);' +
  'try{if(he)return;send()}finally{if(!je)Te=0;if(!ie)me()}}' +
  'function me(){if(ie)return;j=setTimeout(Ee,Te>0?cn:v)}' +
  'function Je(){if(ie)return;if(t(`[AgentSummary] Stopping summarization for ${e}`),ie=!0,j)clearTimeout(j),j=null;if(de)de.abort(),de=null}' +
  'return me(),{stop:Je}}';

const FIXTURE_DOLLAR = FIXTURE.replace(/\bMe\b/g, '$e').replace(/\bj\b/g, 'j$');

describe('writeDisableAgentSummaries', () => {
  it('makes the scheduler return before arming the summary timer', () => {
    const out = writeDisableAgentSummaries(FIXTURE);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function xe(){/*tweakcc:disable-agent-summaries*/return;if(j)return;'
    );
    expect(out).toContain('ue=setTimeout(Me,Re)}');
    expect(out).toContain('return xe(),{stop:Le}}');
    expect(out).toContain('[AgentSummary] Stopping summarization');
  });

  it('never arms a timer when the summarizer starts', () => {
    const out = writeDisableAgentSummaries(FIXTURE)!;
    const setTimeoutSpy = vi.fn();
    const run = new Function(
      'setTimeout',
      'clearTimeout',
      't',
      'send',
      'Pi',
      `${out};return Ui("a","b",{},{},{});`
    );
    const handle = run(
      setTimeoutSpy,
      () => {},
      () => {},
      () => {},
      30000
    );
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it('arms the timer in the unpatched control', () => {
    const setTimeoutSpy = vi.fn();
    const run = new Function(
      'setTimeout',
      'clearTimeout',
      't',
      'send',
      'Pi',
      `${FIXTURE};return Ui("a","b",{},{},{});`
    );
    run(
      setTimeoutSpy,
      () => {},
      () => {},
      () => {},
      30000
    );
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  describe('CC 2.1.316 shape', () => {
    const runDi = (code: string, setTimeoutSpy: (...a: unknown[]) => void) =>
      new Function(
        'setTimeout',
        'clearTimeout',
        't',
        'send',
        'hu',
        'cn',
        `${code};return Di("a","b",{},()=>[],new Map,{});`
      )(
        setTimeoutSpy,
        () => {},
        () => {},
        () => {},
        30000,
        5000
      );

    it('makes the scheduler return before arming the summary timer', () => {
      const out = writeDisableAgentSummaries(FIXTURE_316);
      expect(out).not.toBeNull();
      expect(out).toContain(
        'function me(){/*tweakcc:disable-agent-summaries*/return;if(ie)return;j=setTimeout(Ee,Te>0?cn:v)}'
      );
      expect(out).toContain('if(!ie)me()}}');
      expect(out).toContain('return me(),{stop:Je}}');
      expect(out).toContain('[AgentSummary] Stopping summarization');
    });

    it('never arms a timer, and stop still works', () => {
      const spy = vi.fn();
      const handle = runDi(writeDisableAgentSummaries(FIXTURE_316)!, spy);
      expect(spy).not.toHaveBeenCalled();
      expect(() => handle.stop()).not.toThrow();
    });

    it('arms the timer in the unpatched control', () => {
      const spy = vi.fn();
      runDi(FIXTURE_316, spy);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('handles minified names containing $', () => {
      const dollar = FIXTURE_316.replace(/\bEe\b/g, '$E').replace(
        /\bie\b/g,
        'i$'
      );
      expect(writeDisableAgentSummaries(dollar)).toContain(
        'function me(){/*tweakcc:disable-agent-summaries*/return;if(i$)return;j=setTimeout($E,'
      );
    });

    it('is idempotent', () => {
      const once = writeDisableAgentSummaries(FIXTURE_316)!;
      expect(writeDisableAgentSummaries(once)).toBe(once);
    });
  });

  it('handles minified names containing $', () => {
    const out = writeDisableAgentSummaries(FIXTURE_DOLLAR);
    expect(out).toContain(
      'function xe(){/*tweakcc:disable-agent-summaries*/return;if(j$)return;'
    );
  });

  it('is idempotent', () => {
    const once = writeDisableAgentSummaries(FIXTURE)!;
    expect(writeDisableAgentSummaries(once)).toBe(once);
  });

  it('is a no-op when the summarizer is gone', () => {
    const file = 'function a(){return 1}';
    expect(writeDisableAgentSummaries(file)).toBe(file);
  });

  describe('when the scheduler is reshaped', () => {
    const reshaped = FIXTURE.replace(
      'function xe(){if(j)return;let we=fe(R.calls),Re=Math.min(Pe<we?we-Pe:we,Pi);Pe+=Re,ue=setTimeout(Me,Re)}',
      'function xe(){if(j)return;ue=schedule(()=>Me(),fe(R.calls))}' +
        'function schedule(f,d){return setTimeout(f,d)}'
    );

    it('patches the timer callback instead', () => {
      const out = writeDisableAgentSummaries(reshaped);
      expect(out).toContain(
        'async function Me(){/*tweakcc:disable-agent-summaries*/return;if(j)return;'
      );
      expect(writeDisableAgentSummaries(out!)).toBe(out);
    });

    it('sends no summary and arms the timer at most once', async () => {
      const out = writeDisableAgentSummaries(reshaped)!;
      const send = vi.fn();
      const timers: (() => unknown)[] = [];
      const handle = new Function(
        'setTimeout',
        'clearTimeout',
        't',
        'send',
        'Pi',
        `${out};return Ui("a","b",{},{},{});`
      )(
        (f: () => unknown) => {
          timers.push(f);
          return timers.length;
        },
        () => {},
        () => {},
        send,
        30000
      );
      await timers[0]?.();
      expect(send).not.toHaveBeenCalled();
      expect(timers).toHaveLength(1);
      expect(() => handle.stop()).not.toThrow();
    });
  });

  it('fails when the timer callback cannot be found', () => {
    const broken = FIXTURE.replace(
      'async function Me(){',
      'const Me=async()=>{'
    );
    expect(writeDisableAgentSummaries(broken)).toBeNull();
  });
});
