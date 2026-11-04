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

describe('writeFixSummarizeFromHere', () => {
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
