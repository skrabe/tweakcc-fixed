import { describe, expect, it } from 'vitest';
import { writeFixRewindSummaryHeader } from './fixRewindSummaryHeader';

const HEADER_DEF =
  'function jR_(H,_,q,K,O){let z=`This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\\n\\n${fOO(H)}`;}';
const CALL =
  'content:jR_(y,!1,r,void 0,s),isCompactSummary:!0,...J.length>0?{summarizeMetadata:{messagesSummarized:j.length,userContext:O,direction:T}}:{isVisibleInTranscriptOnly:!0}';

// CC 2.1.210+: the header helper takes an options-object arg.
const CALL_2210 =
  'content:X6r(H,{suppressFollowUpQuestions:!1,transcriptPath:V,replStateCleared:j}),isCompactSummary:!0,...m.length>0?{summarizeMetadata:{messagesSummarized:f.length,userContext:i,direction:s}}:{isVisibleInTranscriptOnly:!0}';

// CC 2.1.285+: the helper returns {content,modelOnlyText?}, spread into the message.
const CALL_2285 =
  'ke({...a2(Ut,{suppressFollowUpQuestions:!1,transcriptPath:Qn,...!1,foreignArtifactContent:eqe(b==="up_to"?Se:e)}),isCompactSummary:!0,...Ee.length>0?{summarizeMetadata:{messagesSummarized:Se.length,userContext:h,direction:b}}:{isVisibleInTranscriptOnly:!0}})';

// CC 2.1.318+: the spread helper's options object holds a nested object.
const CALL_2318 =
  'Po=[Ie({...Yte(Qt,{suppressFollowUpQuestions:!1,transcriptPath:ko,...ae()&&Ni()&&{replBindingsKept:uDn(r.toolState,r.agentId)},foreignArtifactContent:bLn(_o),remoteControlDeviceReport:c7e(_o,uv),toolNamesUsed:QX(e,r.agentContext,r.agentId)}),isCompactSummary:!0,...Re.length>0?{summarizeMetadata:{messagesSummarized:Ce.length,userContext:y,direction:b}}:{isVisibleInTranscriptOnly:!0}})]';

describe('writeFixRewindSummaryHeader', () => {
  it('matches the CC 2.1.318 spread call whose options object nests braces', () => {
    const out = writeFixRewindSummaryHeader(`${HEADER_DEF}x;${CALL_2318};`);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'Po=[Ie({...(($rw)=>({...$rw,content:$rw.content.replace(/This session is being continued from a previous conversation that ran out of context\\.[^\\n]*/,b==="up_to"?'
    );
    // the whole helper call, nested object included, is wrapped intact
    expect(out).toContain(
      '))(Yte(Qt,{suppressFollowUpQuestions:!1,transcriptPath:ko,...ae()&&Ni()&&{replBindingsKept:uDn(r.toolState,r.agentId)},foreignArtifactContent:bLn(_o),remoteControlDeviceReport:c7e(_o,uv),toolNamesUsed:QX(e,r.agentContext,r.agentId)})),isCompactSummary:!0,...Re.length>0?{summarizeMetadata:{messagesSummarized:Ce.length,userContext:y,direction:b}}:{isVisibleInTranscriptOnly:!0}})]'
    );
    expect(out).toContain(HEADER_DEF);
    expect(
      () => new Function(`let Po;${out!.slice(HEADER_DEF.length + 2)}`)
    ).not.toThrow();
    expect(writeFixRewindSummaryHeader(out!)).toBe(out);
  });

  it('matches the CC 2.1.285 spread-object helper call site and keeps other fields', () => {
    const out = writeFixRewindSummaryHeader(`${HEADER_DEF}x;${CALL_2285};`);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'ke({...(($rw)=>({...$rw,content:$rw.content.replace(/This session is being continued from a previous conversation that ran out of context\\.[^\\n]*/,b==="up_to"?'
    );
    expect(out).toContain('))(a2(Ut,{suppressFollowUpQuestions:!1');
    expect(out).toContain(',isCompactSummary:!0,');
    expect(writeFixRewindSummaryHeader(out!)).toBe(out);
  });

  it('wraps the rewind jR_ call with a direction-aware header swap', () => {
    const out = writeFixRewindSummaryHeader(`${HEADER_DEF}x;${CALL};`);
    expect(out).toContain(
      'content:jR_(y,!1,r,void 0,s).replace(/This session is being continued from a previous conversation that ran out of context\\.[^\\n]*/,T==="up_to"?'
    );
    // auto/manual compaction header (the definition) is untouched
    expect(out).toContain(HEADER_DEF);
  });

  it('matches the CC 2.1.210 object-arg header helper call site', () => {
    const out = writeFixRewindSummaryHeader(`${HEADER_DEF}x;${CALL_2210};`);
    expect(out).toContain(
      'content:X6r(H,{suppressFollowUpQuestions:!1,transcriptPath:V,replStateCleared:j}).replace(/This session is being continued from a previous conversation that ran out of context\\.[^\\n]*/,s==="up_to"?'
    );
    expect(out).toContain(HEADER_DEF);
  });

  it('tolerates minifier-renamed identifiers including $', () => {
    const call =
      'content:$z($y,!1,$r,void 0,$s),isCompactSummary:!0,...$J.length>0?{summarizeMetadata:{messagesSummarized:$j.length,userContext:$O,direction:$T}}:{x:1}';
    const out = writeFixRewindSummaryHeader(`${HEADER_DEF}${call}`);
    expect(out).toContain('content:$z($y,!1,$r,void 0,$s).replace(');
    expect(out).toContain('$T==="up_to"?');
  });

  it('is idempotent on already-patched input', () => {
    const once = writeFixRewindSummaryHeader(`${HEADER_DEF}x;${CALL};`);
    expect(once).not.toBeNull();
    expect(writeFixRewindSummaryHeader(once!)).toBe(once);
  });

  it('fails loud when the rewind call site is gone', () => {
    expect(
      writeFixRewindSummaryHeader(`${HEADER_DEF}no call site;`)
    ).toBeNull();
  });

  it('fails loud when the header phrase changed (call site present)', () => {
    expect(writeFixRewindSummaryHeader(`${CALL};`)).toBeNull();
  });
});
