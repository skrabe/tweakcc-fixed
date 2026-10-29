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

  it('fails when the scheduler shape changes', () => {
    const broken = FIXTURE.replace('ue=setTimeout(Me,Re)', 'ue=later(Me,Re)');
    expect(writeDisableAgentSummaries(broken)).toBeNull();
  });
});
