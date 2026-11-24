import { describe, expect, it } from 'vitest';
import { writeFixSummarizeFromHere } from './fixSummarizeFromHere';

// Minified shape mirroring the real YFK span (darwin-style names).
const SPAN =
  'W={preCompactTokenCount:D,direction:T,messagesSummarized:j.length},' +
  'G=T==="up_to"?j:H,R=T==="up_to"?{...K,forkContextMessages:j}:K,h,y,E=0;for(;;){';

// 2.1.318 shape: the retry-request expression sits between the two ternaries.
const SPAN_318 =
  'xt={preCompactTokenCount:Ke,direction:p(b),messagesSummarized:Ce.length},' +
  'Et=b==="up_to"?Ce:e,Tt=Qe+Aft(Et).map((Jn)=>`\n\n${Jn}`).join(""),' +
  'mt=b==="up_to"?{...s,forkContextMessages:Ce}:s,Ot,Qt,Nt=0;for(;;){';

const SPAN_330 =
  'Bt={preCompactTokenCount:tt,direction:f(k),messagesSummarized:Ee.length},' +
  'At=k==="up_to"?Ee:e,pt=Et+J9(At).map((Ho)=>`\n\n${Ho}`).join(""),' +
  'Wt=Qge(g,e),an=k==="up_to"?{...Wt,forkContextMessages:Ee}:Wt,Gt,Jt,En=0;for(;;){';

// 2.1.331 shape: the first ternary closes its `let`, a telemetry call over the
// summarizer input runs, and a new `let` resumes with the retry request.
const SPAN_331 =
  'gt={preCompactTokenCount:Ke,direction:f(k),messagesSummarized:we.length},' +
  'at=k==="up_to"?we:e;trn(at,X8e(r.agentContext),void 0);' +
  'let Ct=mt+v6(at).map((bo)=>`\n\n${bo}`).join(""),' +
  'Ut=hye(g,e),zt=k==="up_to"?{...Ut,forkContextMessages:we}:Ut,Ht,Qt,on=0;for(;;){';

describe('writeFixSummarizeFromHere', () => {
  it('2.1.331 shape: collapses both branches, keeps the telemetry call and let split', () => {
    const out = writeFixSummarizeFromHere(`x;${SPAN_331}y;`);
    expect(out).toBe(
      'x;gt={preCompactTokenCount:Ke,direction:f(k),messagesSummarized:we.length},' +
        'at=we;trn(at,X8e(r.agentContext),void 0);' +
        'let Ct=mt+v6(at).map((bo)=>`\n\n${bo}`).join(""),' +
        'Ut=hye(g,e),zt={...Ut,forkContextMessages:we},Ht,Qt,on=0;for(;;){y;'
    );
    expect(out).not.toContain('==="up_to"');
    // The summarizer input still feeds telemetry, the retry markers and the
    // wrapper still receives the full conversation.
    expect(out).toContain('trn(at,');
    expect(out).toContain('v6(at)');
    expect(out).toContain('Ut=hye(g,e)');
  });

  it('2.1.331 shape: is idempotent on already-patched input', () => {
    const once = writeFixSummarizeFromHere(`x;${SPAN_331}y;`);
    expect(once).not.toBeNull();
    expect(writeFixSummarizeFromHere(once!)).toBe(once);
  });

  it('2.1.330 shape: collapses both branches, keeps the cache-params wrapper', () => {
    const out = writeFixSummarizeFromHere(`x;${SPAN_330}y;`);
    expect(out).toBe(
      'x;Bt={preCompactTokenCount:tt,direction:f(k),messagesSummarized:Ee.length},' +
        'At=Ee,pt=Et+J9(At).map((Ho)=>`\n\n${Ho}`).join(""),' +
        'Wt=Qge(g,e),an={...Wt,forkContextMessages:Ee},Gt,Jt,En=0;for(;;){y;'
    );
    expect(out).not.toContain('==="up_to"');
  });

  it('2.1.330 shape: is idempotent on already-patched input', () => {
    const once = writeFixSummarizeFromHere(`x;${SPAN_330}y;`);
    expect(once).not.toBeNull();
    expect(writeFixSummarizeFromHere(once!)).toBe(once);
  });

  it('2.1.318 shape: collapses both branches, keeps the intermediate expression', () => {
    const out = writeFixSummarizeFromHere(`x;${SPAN_318}y;`);
    expect(out).toBe(
      'x;xt={preCompactTokenCount:Ke,direction:p(b),messagesSummarized:Ce.length},' +
        'Et=Ce,Tt=Qe+Aft(Et).map((Jn)=>`\n\n${Jn}`).join(""),' +
        'mt={...s,forkContextMessages:Ce},Ot,Qt,Nt=0;for(;;){y;'
    );
    expect(out).not.toContain('==="up_to"');
  });

  it('2.1.318 shape: is idempotent on already-patched input', () => {
    const once = writeFixSummarizeFromHere(`x;${SPAN_318}y;`);
    expect(once).not.toBeNull();
    expect(writeFixSummarizeFromHere(once!)).toBe(once);
  });

  it('collapses both branches to the slice (feeds j, sets forkContextMessages)', () => {
    const out = writeFixSummarizeFromHere(`x;${SPAN}y;`);
    expect(out).toContain(
      'messagesSummarized:j.length},G=j,R={...K,forkContextMessages:j},h,y,E=0;'
    );
    expect(out).not.toContain('G=T==="up_to"?j:H');
  });

  it('tolerates minifier-renamed identifiers including $', () => {
    const span =
      '$W={preCompactTokenCount:$d,direction:$T,messagesSummarized:$j.length},' +
      '$G=$T==="up_to"?$j:$H,$R=$T==="up_to"?{...$K,forkContextMessages:$j}:$K,a;';
    const out = writeFixSummarizeFromHere(span);
    expect(out).toContain('$G=$j,$R={...$K,forkContextMessages:$j}');
  });

  it('is idempotent on already-patched input', () => {
    const once = writeFixSummarizeFromHere(`x;${SPAN}y;`);
    expect(once).not.toBeNull();
    expect(writeFixSummarizeFromHere(once!)).toBe(once);
  });

  it('fails loud when the ternary shape is gone', () => {
    expect(writeFixSummarizeFromHere('no summarize span here;')).toBeNull();
  });
});
