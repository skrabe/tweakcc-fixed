import { describe, it, expect, vi } from 'vitest';
import { writeSuppressLineNumbers } from './suppressLineNumbers';

// suppress-line-numbers strips the line-number prefix the Read tool injects.
// Two CC shapes:
//
// MAIN (CC 2.1.140+): a `{content:VAR,startLine:VAR2,tabAwareSeparator:VAR3=!1}`
// formatter whose body, after the `if(!content)return""` empty-guard, maps each
// line to `<num><sep><content>`. The patch replaces that body with `return content`,
// rewrites the per-line `<num><sep><content>` helper to just return the content,
// and swaps the two Read-tool prompt sentences that describe cat -n formatting.
const FORMATTER =
  'function Hf({content:J,startLine:G,tabAwareSeparator:Q=!1}){if(!J)return"";' +
  'let L=J.split(/\\r?\\n/);return L.map((R,X)=>{let Z=G+X;return Z+"\\t"+R}).join("\\n")}';
// the per-line helper: `<line-prefix><stripped-content><suffix>`
const HELPER =
  'function $k(W,Y,Z){let q=W.endsWith("\\r")?W.slice(0,-1):W;return`${Y}${q}${Z}`}';
const READ_PROMPT_1 =
  '"- Results are returned using cat -n format, with line numbers starting at 1"';
const READ_PROMPT_2 =
  '`${V0}. Each line is the line number, a single separator (a tab or `:`),' +
  ' then the verbatim file content (including any leading whitespace).`';

const FIXTURE =
  'a=1;' + FORMATTER + HELPER + READ_PROMPT_1 + ';' + READ_PROMPT_2 + ';z=2;';

// ARROW (CC <2.1.88): the older arrow-formatter shape, where the line number is
// joined to the content with `→` / `→`.
const ARROW_FIXTURE =
  'q=1;if(J.length>=5)return`${J}\\u2192${G}`;' +
  'return`${J.padStart(5," ")}\\u2192${G}`;z=2;';

describe('writeSuppressLineNumbers', () => {
  it('replaces the formatter body with a bare content return (main shape)', () => {
    const out = writeSuppressLineNumbers(FIXTURE);
    expect(out).not.toBeNull();
    // empty guard preserved, then the body collapses to `return <content>`
    expect(out).toContain('if(!J)return"";return J}');
    // the original line-numbering map body is gone
    expect(out).not.toContain('let L=J.split(/\\r?\\n/)');
  });

  it('rewrites the per-line helper to drop the number/separator wrapping', () => {
    const out = writeSuppressLineNumbers(FIXTURE)!;
    expect(out).toContain(
      'function $k(W){return W.endsWith("\\r")?W.slice(0,-1):W}'
    );
    // the wrapping template that prefixed the line number is gone
    expect(out).not.toContain('`${Y}${q}${Z}`');
  });

  it('rewrites the Read-tool prompt sentences that describe cat -n output', () => {
    const out = writeSuppressLineNumbers(FIXTURE)!;
    expect(out).toContain(
      '"- Results are returned as raw file content without line-number prefixes"'
    );
    expect(out).toContain(
      '`Results are raw file content without line-number prefixes.`'
    );
    expect(out).not.toContain('cat -n format');
  });

  it('handles the older arrow-formatter shape (fallback path)', () => {
    const out = writeSuppressLineNumbers(ARROW_FIXTURE);
    expect(out).not.toBeNull();
    // the whole if/return arrow expression collapses to returning the content var
    expect(out).toBe('q=1;return G;z=2;');
    expect(out).not.toContain('padStart');
  });

  it('returns null (without throwing) when no formatter shape is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeSuppressLineNumbers('x=1;function unrelated(){return 1}')
    ).toBeNull();
    errSpy.mockRestore();
  });
});
