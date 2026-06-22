import { describe, it, expect } from 'vitest';
import {
  escapeForTemplateLiteral,
  writeUserMessageDisplay,
} from './userMessageDisplay';
import { UserMessageDisplayConfig } from '../types';

const BT = '`';

// userMessageDisplay splices config.format into a backtick template literal in
// cli.js. config.format can come from an untrusted --config-url, so it must be
// escaped: a backtick would terminate the literal (binary corruption) and a
// ${...} would inject an executable expression into Claude Code.
describe('escapeForTemplateLiteral', () => {
  it('is a no-op for a normal format (no regression for the common case)', () => {
    expect(escapeForTemplateLiteral(' > {} ')).toBe(' > {} ');
    expect(escapeForTemplateLiteral('[you]: {}')).toBe('[you]: {}');
  });

  it('escapes a backtick so it cannot terminate the template literal', () => {
    expect(escapeForTemplateLiteral('a' + BT + 'b')).toBe('a\\' + BT + 'b');
  });

  it('escapes ${...} so it cannot inject an executable expression', () => {
    expect(escapeForTemplateLiteral('${process.exit(1)}')).toBe(
      '\\${process.exit(1)}'
    );
  });

  it('escapes backslashes so an escape sequence cannot leak', () => {
    expect(escapeForTemplateLiteral('a\\b')).toBe('a\\\\b');
  });

  it('leaves the {} placeholder intact (it is replaced by the message after escaping)', () => {
    expect(escapeForTemplateLiteral('x{}y')).toBe('x{}y');
  });
});

// CC 2.1.186 switched its UI bundle from `React.createElement(...)` to the
// automatic JSX runtime (`MOD.jsx(comp,{…,children:…})`). The runtime module
// exposes `.jsx`/`.jsxs` but NOT `.createElement`, and the user-message render
// is split across two React-compiler memo blocks with the bg ternary hoisted
// into a local var. This fixture mirrors that real minified shape so the patch
// is exercised on the path that broke (`failed to find user message display
// pattern`).
const TEXT_FN_186 =
  'function v({color:A,backgroundColor:B,dimColor:C=!1,bold:D=!1,italic:E=!1}){return null}';
const CHALK_186 =
  'var St={};St.rgb(1,2,3).bgRgb(4,5,6).bold("x");St.bold("y");St.dim("z");St.italic("w");St.underline("u");';
const BOX_FN_186 =
  'function Whd({children:Q,ref:R,tabIndex:S,autoFocus:T}){return null}';
const USER_MSG_186 =
  'function Tqa(e){let t=yqa.c(23),{addMargin:n,param:r,timestamp:s}=e,{text:i}=r,p;p=i;let m=p;' +
  'if(!i)return xe(Error("No content found in user prompt message")),null;' +
  'let f=n?1:0,h=d?void 0:"userMessageBackground",g=d?0:1,_=d?s:void 0,T;' +
  'if(t[14]!==m||t[15]!==_||t[16]!==d)T=Jpo.jsx(hqa,{text:m,useBriefLayout:d,timestamp:_}),' +
  't[14]=m,t[15]=_,t[16]=d,t[17]=T;else T=t[17];let y;' +
  'if(t[18]!==f||t[19]!==h||t[20]!==g||t[21]!==T)' +
  'y=Jpo.jsx($,{flexDirection:"column",marginTop:f,backgroundColor:h,paddingRight:g,children:T}),' +
  't[18]=f,t[19]=h,t[20]=g,t[21]=T,t[22]=y;else y=t[22];return y}';
const FIXTURE_186 =
  TEXT_FN_186 + ';' + CHALK_186 + BOX_FN_186 + ';' + USER_MSG_186;

const baseConfig: UserMessageDisplayConfig = {
  format: ' > {} ',
  styling: [],
  foregroundColor: 'default',
  backgroundColor: 'default',
  borderStyle: 'none',
  borderColor: 'rgb(0,0,0)',
  paddingX: 'default',
  paddingY: 'default',
  fitBoxToContent: false,
};

// Verify JS delimiter parity OUTSIDE backtick template literals: an unbalanced
// `{`/`}`/`(`/`)` or a stray backtick is the "function wrapper" corruption
// class. Template-literal interiors are skipped (their braces/parens are text).
const delimiterDelta = (
  s: string
): { brace: number; paren: number; inTemplate: boolean } => {
  let brace = 0,
    paren = 0,
    inTemplate = false,
    esc = false;
  for (const c of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '`') {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) continue;
    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '(') paren++;
    else if (c === ')') paren--;
  }
  return { brace, paren, inTemplate };
};

describe('writeUserMessageDisplay — CC 2.1.186 JSX runtime', () => {
  it('matches the JSX-runtime shape that the createElement patterns no longer find', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, baseConfig);
    expect(out).not.toBeNull();
    // It must NOT be a no-op (the bug returned oldFile unchanged) and must NOT
    // print the failure-to-find error path.
    expect(out).not.toBe(FIXTURE_186);
  });

  it('emits `.jsx(...)` not `.createElement(...)` (the runtime module has no createElement)', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, baseConfig)!;
    // our injected Text element is built with the captured jsx module (Jpo)
    expect(out).toContain('Jpo.jsx(v,{');
    // we did not introduce any createElement call
    expect(out).not.toContain('.createElement(');
  });

  it('preserves the Box layout attrs (flexDirection/marginTop) for wrap width', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, baseConfig)!;
    expect(out).toContain('flexDirection:"column"');
    expect(out).toContain('marginTop:f');
  });

  it("default bg leaves CC's hoisted backgroundColor var untouched", () => {
    const out = writeUserMessageDisplay(FIXTURE_186, baseConfig)!;
    expect(out).toContain('backgroundColor:h');
    // Text mirrors the native theme token for a continuous highlight.
    expect(out).toContain('backgroundColor:"userMessageBackground"');
  });

  it('custom rgb bg swaps the hoisted var for an rgb literal on both Box and Text', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, {
      ...baseConfig,
      backgroundColor: 'rgb(40,40,40)',
    })!;
    // the bare `backgroundColor:h` is gone; the rgb literal appears twice
    // (Box + Text).
    expect(out).not.toContain('backgroundColor:h');
    const occurrences = out.split('backgroundColor:"rgb(40,40,40)"').length - 1;
    expect(occurrences).toBe(2);
  });

  it('"none" bg strips the Box backgroundColor attr cleanly (no dangling comma)', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, {
      ...baseConfig,
      backgroundColor: null,
    })!;
    expect(out).not.toContain('backgroundColor:h');
    // the surrounding attrs survive and stay comma-joined
    expect(out).toContain('marginTop:f,paddingRight:g');
    expect(out).not.toContain(',,');
  });

  it('escapes a hostile --config-url format so it cannot break the template or inject', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, {
      ...baseConfig,
      format: '`a${process.exit(1)}b` {}',
    })!;
    // backticks and ${ from the format are escaped inside the emitted literal
    expect(out).toContain('\\`a\\${process.exit(1)}b\\`');
    // delimiter parity holds (no premature template termination)
    const delta = delimiterDelta(out);
    expect(delta.brace).toBe(0);
    expect(delta.paren).toBe(0);
    expect(delta.inTemplate).toBe(false);
  });

  it('produces a balanced, syntactically valid replacement (no function-wrapper corruption)', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, {
      ...baseConfig,
      backgroundColor: 'rgb(40,40,40)',
      foregroundColor: 'rgb(200,0,0)',
      borderStyle: 'topBottomSingle',
      borderColor: 'rgb(100,100,100)',
      paddingX: 2,
      paddingY: 1,
      fitBoxToContent: true,
      styling: ['bold', 'italic', 'underline', 'strikethrough', 'inverse'],
    })!;
    const delta = delimiterDelta(out);
    expect(delta.brace).toBe(0);
    expect(delta.paren).toBe(0);
    expect(delta.inTemplate).toBe(false);
    // the rewritten Tqa function must parse as valid JS
    const start = out.indexOf('function Tqa(e){');
    let depth = 0;
    let end = out.indexOf('{', start);
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const fnSrc = out.slice(start, end + 1);
    expect(() => new Function(`return (${fnSrc})`)).not.toThrow();
    // border glyph is \uXXXX-escaped (mojibake-safe on Bun's Latin-1 storage)
    expect(fnSrc).toContain('\\u2500');
    expect(fnSrc).not.toContain('─');
  });

  it('handles the long-paste object variant via the unwrapping ternary', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, baseConfig)!;
    // the message var `m` may be {head,hiddenLines,tail}; we flatten it inline
    expect(out).toContain('typeof m==="object"');
    expect(out).toContain('m.head');
    expect(out).toContain('m.tail');
    expect(out).toContain('" hidden)');
  });
});
