import { describe, expect, it } from 'vitest';
import { writeLeanMemoryTypes } from './leanMemoryTypes';

const GATE = 'function nL8(){return j_("tengu_ochre_finch",!1)}';

describe('writeLeanMemoryTypes', () => {
  it('inserts return!0; at the start of the gate body', () => {
    const file = `before;${GATE}after;`;
    const result = writeLeanMemoryTypes(file);
    expect(result).toContain(
      'function nL8(){return!0;return j_("tengu_ochre_finch",!1)}'
    );
  });

  it('tolerates minifier-renamed identifiers including $', () => {
    const file =
      'function $a1(){return $b2("tengu_ochre_finch",!1)}function $c3(){}';
    const result = writeLeanMemoryTypes(file);
    expect(result).toContain(
      'function $a1(){return!0;return $b2("tengu_ochre_finch",!1)}'
    );
  });

  it('is idempotent on already-patched input', () => {
    const patched = writeLeanMemoryTypes(`x;${GATE}y;`);
    expect(patched).not.toBeNull();
    expect(writeLeanMemoryTypes(patched!)).toBe(patched);
  });

  it('no-ops when the flag literal is gone (feature promoted)', () => {
    const file = 'function nL8(){return!0}';
    expect(writeLeanMemoryTypes(file)).toBe(file);
  });

  it('fails loud when the flag exists but the shape changed', () => {
    const file = 'let x="tengu_ochre_finch";somethingElse();';
    expect(writeLeanMemoryTypes(file)).toBeNull();
  });
});
