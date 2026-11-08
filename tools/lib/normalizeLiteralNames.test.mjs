import { describe, expect, it } from 'vitest';
import { normalizeLiteralNames as n } from './normalizeLiteralNames.mjs';

describe('normalizeLiteralNames', () => {
  it('treats minified renames as equal, in any case and position', () => {
    for (const [a, b] of [
      ['`x ${q(z)} y`', '`x ${q(w)} y`'],
      ['[A,zq(),B]', '[C,hk(),D]'],
      ['`${A?"yes":c}`', '`${A?"yes":d}`'],
      [
        '["## Save",...wJt,`- ${or}`,...Xa]',
        '["## Save",...Uen,`- ${lr}`,...cl]',
      ],
      [
        '`${f.map((_)=>`- ${_}`).join(`\\n`)}`',
        '`${p.map((x)=>`- ${x}`).join(`\\n`)}`',
      ],
    ])
      expect(n(a)).toBe(n(b));
  });

  it('keeps every prose, number and property-name change visible', () => {
    for (const [a, b] of [
      ['"You MUST run tests"', '"You MAY run tests"'],
      ['`Use the Read tool ${x}`', '`Use the Edit tool ${x}`'],
      ['`under 100 lines`', '`under 300 lines`'],
      ['["use Bash",a]', '["use Grep",a]'],
      ['`${e.length} files`', '`${e.size} files`'],
    ])
      expect(n(a)).not.toBe(n(b));
  });
});
