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

// CC 2.1.246 ESM-split: jsx/jsxs are imported bindings (`o(Comp,{...})`),
// not `MOD.jsx(...)`. Verbatim shape from /tmp/cli-2.1.246.js function tM.
// Ink's Text is defined as `v` in its own module, exported as `Tx` and
// imported here as `t`; splicing `v` would be a ReferenceError.
const TEXT_FN_DECOY =
  'function v({color:A,backgroundColor:B,dimColor:C=!1,bold:D=!1}){return null}';
const MARK = (n: number, path: string): string =>
  `\n/*@@TWEAKCC_MODULE:${n}:${path}@@*/\n`;
const INK_TEXT_MODULE =
  MARK(1, '/$bunfs/root/chunk-ink.js') + TEXT_FN_DECOY + ';export{v as Tx};';
const USER_MODULE_HEAD =
  MARK(2, '/$bunfs/root/chunk-msg.js') +
  'import{Tx as t}from"/$bunfs/root/chunk-ink.js";';
const LOCAL_TEXT_246 = 'o(t,{color:"text",children:"hi"});';
const USER_MSG_246 =
  'function tM(Ute){let Mm=R(23),{addMargin:Ete,param:vte,timestamp:Ate}=Ute,{text:ls}=vte;' +
  'if(!ls){return Ye(Error("No content found in user prompt message")),null}' +
  'const xm=Ete?1:0,km=bm?void 0:"userMessageBackground",_m=bm?0:1,Pm=bm?Ate:void 0;let Zy;' +
  'if(Mm[14]!==wE||Mm[15]!==Pm||Mm[16]!==bm)Zy=o(Ff,{text:wE,useBriefLayout:bm,timestamp:Pm}),' +
  'Mm[14]=wE,Mm[15]=Pm,Mm[16]=bm,Mm[17]=Zy;else Zy=Mm[17];let zz;' +
  'if(Mm[18]!==xm||Mm[19]!==km||Mm[20]!==_m||Mm[21]!==Zy)' +
  'zz=o(a,{flexDirection:"column",marginTop:xm,backgroundColor:km,paddingRight:_m,children:Zy}),' +
  'Mm[18]=xm,Mm[19]=km,Mm[20]=_m,Mm[21]=Zy,Mm[22]=zz;else zz=Mm[22];return zz}';
const FIXTURE_246 =
  INK_TEXT_MODULE +
  USER_MODULE_HEAD +
  CHALK_186 +
  LOCAL_TEXT_246 +
  USER_MSG_246;

const REAL_CONFIG: UserMessageDisplayConfig = {
  format: ' > {} ',
  styling: [],
  foregroundColor: 'default',
  backgroundColor: 'rgb(28,32,48)',
  borderStyle: 'topBottomBold',
  borderColor: 'rgb(255,32,134)',
  paddingX: 1,
  paddingY: 0,
  fitBoxToContent: false,
};

const SWEEP_CONFIG: UserMessageDisplayConfig = {
  ...baseConfig,
  borderStyle: 'round',
  styling: ['bold'],
};

// CC 2.1.276 appended `awaitingModel` to the child's props; the anchor must
// accept a trailing prop run rather than end at `timestamp`.
const FIXTURE_276 = FIXTURE_246.replace(
  'timestamp:Pm})',
  'timestamp:Pm,awaitingModel:nd})'
);

describe('writeUserMessageDisplay — CC 2.1.276 trailing child props', () => {
  it('matches a child call carrying props after timestamp', () => {
    expect(FIXTURE_276).not.toBe(FIXTURE_246);
    const out = writeUserMessageDisplay(FIXTURE_276, baseConfig);
    expect(out).not.toBeNull();
    expect(out).toContain('flexDirection:"column"');
  });
});

describe('writeUserMessageDisplay — CC 2.1.246 imported jsx helpers', () => {
  it('matches the imported-helper shape that .jsx patterns no longer find', () => {
    const out = writeUserMessageDisplay(FIXTURE_246, baseConfig);
    expect(out).not.toBeNull();
    expect(out).not.toBe(FIXTURE_246);
  });

  it('emits a bare helper call, not .jsx / .createElement', () => {
    const out = writeUserMessageDisplay(FIXTURE_246, baseConfig)!;
    expect(out).toContain('o(t,{');
    expect(out).not.toContain('.jsx(');
    expect(out).not.toContain('.createElement(');
    // must use the local Text import, not the globally-first decoy
    expect(out).not.toContain('o(v,{');
  });

  it('preserves Box layout attrs (flexDirection/marginTop) for wrap width', () => {
    const out = writeUserMessageDisplay(FIXTURE_246, baseConfig)!;
    expect(out).toContain('flexDirection:"column"');
    expect(out).toContain('marginTop:xm');
  });

  it('does not steal a dotted .jsx( call from a 2.1.186 binary', () => {
    const out = writeUserMessageDisplay(FIXTURE_186, baseConfig)!;
    expect(out).toContain('Jpo.jsx(v,{');
    expect(out).not.toMatch(/(?<![.\w$])jsx\(/);
  });

  it('applies the real user config (custom bg, topBottomBold, paddingX:1)', () => {
    const out = writeUserMessageDisplay(FIXTURE_246, REAL_CONFIG)!;
    expect(out).not.toContain('backgroundColor:km');
    const bgHits = out.split('backgroundColor:"rgb(28,32,48)"').length - 1;
    expect(bgHits).toBe(2);
    expect(out).toContain('borderColor:"rgb(255,32,134)"');
    expect(out).toContain('paddingX:1');
    expect(out).not.toContain('paddingY:');
    expect(out).not.toContain('bold:!0');
    // bold box-drawing glyph is \\uXXXX-escaped
    expect(out).toContain('\\u2501');
    expect(out).not.toContain('━');
    const delta = delimiterDelta(out);
    expect(delta.brace).toBe(0);
    expect(delta.paren).toBe(0);
    expect(delta.inTemplate).toBe(false);
  });

  it('applies the sweep fixture (round border, bold styling)', () => {
    const out = writeUserMessageDisplay(FIXTURE_246, SWEEP_CONFIG)!;
    expect(out).toContain('borderStyle:"round"');
    expect(out).toContain('bold:!0');
    expect(out).toContain('backgroundColor:km');
    expect(out).toContain('backgroundColor:"userMessageBackground"');
    const delta = delimiterDelta(out);
    expect(delta.brace).toBe(0);
    expect(delta.paren).toBe(0);
    expect(delta.inTemplate).toBe(false);
  });

  it('unwraps the long-paste object variant on the imported-helper path', () => {
    const out = writeUserMessageDisplay(FIXTURE_246, baseConfig)!;
    expect(out).toContain('typeof wE==="object"');
    expect(out).toContain('wE.head');
    expect(out).toContain('wE.tail');
  });
});

// CC 2.1.328: the first same-module call with `color:"text"` is a glyph-row
// wrapper whose root is a Box (`e(ui,{color:"text",children:o(r,…)})`). The
// old heuristic spliced `ui` as the Text component, so the formatted message
// became a bare string child of a Box and Ink threw "Text string … must be
// rendered inside <Text> component". Text (`r`) is defined and exported
// under the same name by Ink's chunk and imported as-is.
const INK_TEXT_FN_328 =
  'function r(h){let m=k(19),w,C,M,H,I;if(m[0]!==h)({color:C,backgroundColor:w,dimColor:M,bold:I,...H}=h),m[0]=h;return null}';
const INK_MODULE_328 =
  MARK(1177, '/$bunfs/root/chunk-5g8qs913.js') +
  'function g(h){return null}' +
  INK_TEXT_FN_328 +
  ';export{Nvt,g,J2t,r,kn};';
const USER_MSG_328 =
  'function Sh(d){let O=k(38),{addMargin:l,param:m,timestamp:S,messageId:w}=d,{text:N}=m,G=ch(w),ge=Ge,We=Xe;' +
  'if(!N){return i(Error("No content found in user prompt message")),null}' +
  'const ye=l?1:0,xe=ge?void 0:"userMessageBackground",Ke=ge?0:1,Se=ge?S:void 0;let $e;' +
  'if(O[28]!==G||O[29]!==We||O[30]!==Se||O[31]!==ge)$e=e(cWn,{text:We,useBriefLayout:ge,timestamp:Se,awaitingModel:G}),' +
  'O[28]=G,O[29]=We,O[30]=Se,O[31]=ge,O[32]=$e;else $e=O[32];let co;' +
  'if(O[33]!==ye||O[34]!==xe||O[35]!==Ke||O[36]!==$e)' +
  'co=e(g,{flexDirection:"column",marginTop:ye,backgroundColor:xe,paddingRight:Ke,children:$e}),' +
  'O[33]=ye,O[34]=xe,O[35]=Ke,O[36]=$e,O[37]=co;else co=O[37];return co}';
const FIXTURE_328 =
  INK_MODULE_328 +
  MARK(2098, '/$bunfs/root/chunk-bjgpjqze.js') +
  'import{na,Kn,g,r,kn}from"/$bunfs/root/chunk-5g8qs913.js";import{ui}from"/$bunfs/root/chunk-jkpzhr7r.js";' +
  'function Xa(){let U;U=e(ui,{color:"text",children:o(r,{bold:!0,children:["Compact summary",v]})});return U}' +
  USER_MSG_328;

describe('writeUserMessageDisplay — CC 2.1.328 imported Text binding', () => {
  it('wraps the formatted message in the imported Text, not a color:"text" Box wrapper', () => {
    const out = writeUserMessageDisplay(FIXTURE_328, REAL_CONFIG)!;
    expect(out).not.toBeNull();
    const body = out.slice(out.indexOf('function Sh('));
    expect(body).not.toContain('e(ui,');
    expect(body).toContain(
      'paddingX:1,children:e(r,{color:"text",backgroundColor:"rgb(28,32,48)",children:` > ${(typeof We==="object"'
    );
    expect(body).toContain(':We)} `})})');
    expect(body).toContain('co=e(g,{flexDirection:"column",marginTop:ye,');
    const fnSrc = body.slice(
      0,
      body.indexOf('return co}') + 'return co}'.length
    );
    expect(() => new Function(`return (${fnSrc})`)).not.toThrow();
  });

  it('follows an aliased import to the local Text name', () => {
    const aliased = FIXTURE_328.replace(
      'import{na,Kn,g,r,kn}from',
      'import{na,Kn,g,r as Tz,kn}from'
    );
    const out = writeUserMessageDisplay(aliased, REAL_CONFIG)!;
    expect(out).toContain('children:e(Tz,{color:"text"');
  });

  it('fails instead of guessing when the module does not import Text', () => {
    const noImport = FIXTURE_328.replace(
      'import{na,Kn,g,r,kn}from',
      'import{na,Kn,g,kn}from'
    );
    expect(writeUserMessageDisplay(noImport, REAL_CONFIG)).toBeNull();
  });
});
