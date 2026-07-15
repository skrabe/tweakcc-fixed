import { describe, expect, it } from 'vitest';
import { writeFixRewindSummaryHeader } from './fixRewindSummaryHeader';

const HEADER_DEF =
  'function jR_(H,_,q,K,O){let z=`This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\\n\\n${fOO(H)}`;}';
const CALL =
  'content:jR_(y,!1,r,void 0,s),isCompactSummary:!0,...J.length>0?{summarizeMetadata:{messagesSummarized:j.length,userContext:O,direction:T}}:{isVisibleInTranscriptOnly:!0}';

// CC 2.1.210+: the header helper takes an options-object arg.
const CALL_2210 =
  'content:X6r(H,{suppressFollowUpQuestions:!1,transcriptPath:V,replStateCleared:j}),isCompactSummary:!0,...m.length>0?{summarizeMetadata:{messagesSummarized:f.length,userContext:i,direction:s}}:{isVisibleInTranscriptOnly:!0}';

describe('writeFixRewindSummaryHeader', () => {
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
