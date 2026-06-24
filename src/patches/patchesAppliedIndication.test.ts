import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findVersionOutputLocation,
  renderPatchListItemRow,
  writePatchesAppliedIndication,
} from './patchesAppliedIndication';
import { clearReactVarCache } from './helpers';

// patchesAppliedIndication injects a "+ tweakcc" version marker and a
// "✓ tweakcc-fixed patches are applied" list into CC's startup header. The
// always-runs PATCH 1 rewrites the `}.VERSION} (Claude Code)` literal that the
// `--version` / commander help path prints, appending the tweakcc version.
//
// The full write() also needs the React var, chalk var, Text and Box component
// names, resolved from the shared helpers. The fixture below stitches together
// the minified shapes each of those helpers matches so the whole patch runs:
//   - module loader (native shape):  ,J=(H,$,A)=>{A=H!=null?...
//   - react module (non-bun):        var rM=ldr((Z)=>{var s=Symbol.for("react.element")...
//   - react var:                     ;RC=J(rM(),1)
//   - chalk var:                     Qc.hex(...).bold(...) used repeatedly
//   - Text component:                function TX({color:a,backgroundColor:b,dimColor:c=!1,bold:d=!1
//   - Box component (Method 2):      function BX({children:T,flexWrap:F...createElement("ink-box"

const MODULE_LOADER = ',J=(H,$,A)=>{A=H!=null?vH(GH(H)):{};return A};';

const REACT_MODULE =
  'var rM=J((Z)=>{var s=Symbol.for("react.element");Z.x=s});' +
  ';RC=J(rM(),1);';

// chalk used >1 time so the counting method picks Qc
const CHALK = 'Qc.hex("#FF8400").bold("a");Qc.blue.bold("b");Qc.green("c");';

const TEXT_COMPONENT =
  'function TX({color:a,backgroundColor:b,dimColor:c=!1,bold:d=!1,children:e}){return e}';

// findBoxComponent Method 2 scans `function NAME(...children:X,flexWrap:Y` within
// 200 chars of an `ink-box` createElement, so Box must precede Text in the fixture
// or the `.{0,200}` window would let it capture the Text function name instead.
const BOX_COMPONENT =
  'function BX({children:T,flexWrap:F,gap:G}){return RC.createElement("ink-box",{style:1},T)}';

// PATCH 1 anchor: the version literal that the help/`--version` path prints. The
// matcher looks for the exact substring `}.VERSION} (Claude Code)` — a `${...}`
// interpolation closing brace immediately followed by `.VERSION} (Claude Code)`.
const VERSION_OUTPUT = 'help(`${pkg}.VERSION} (Claude Code)`);';

// PATCH 2 Path B anchor: SyK compact borderText chalk call.
const PATCH2_PATH_B = 'K6=N7("claude",e)(" Claude Code ");';

// CC ≥2.1.186 JSX-runtime header (Method 0 for PATCH 2 + PATCH 3). Mirrors the
// real shape: a memoized version row assigned to a var, then a
// flexDirection:"column" Box that lists that var as its first child. The version
// row is `HELPER.jsxs(TEXT,{children:[<bold title>," ",HELPER.jsxs(TEXT,
// {dimColor:!0,children:["v",VER]})]})`. The assignment is preceded by `)` (an
// `if(e[N]!==d)` guard) to exercise the close-paren boundary in the matcher.
const JSX_HEADER =
  'function Hdr(e){' +
  'let Wy;if(e[1]!==d)' +
  'Wy=RC.jsxs(TX,{children:[RC.jsx(TX,{bold:!0,children:"Claude Code"})," ",' +
  'RC.jsxs(TX,{dimColor:!0,children:["v",vv]})]}),e[1]=d,e[2]=Wy;else Wy=e[2];' +
  'let Sy=RC.jsx(TX,{dimColor:!0,children:"sub"}),Ey=null;' +
  'return RC.jsxs(BX,{flexDirection:"column",children:[Wy,Sy,Ey]})}';

// A complete, well-formed fixture that every helper + PATCH 1 + PATCH 2/B can
// match. PATCH 3/4/5 may no-op on this synthetic shape; that's fine — they are
// designed to skip gracefully and still return the PATCH-1/2-modified content.
const FIXTURE =
  'var pre=1;' +
  MODULE_LOADER +
  REACT_MODULE +
  CHALK +
  BOX_COMPONENT +
  ';' +
  TEXT_COMPONENT +
  ';' +
  PATCH2_PATH_B +
  VERSION_OUTPUT +
  'var post=2;';

// Fixture that additionally carries the JSX-runtime header so PATCH 2 Method 0
// and PATCH 3 Method 0 (CC ≥2.1.186) actually match and inject.
const JSX_FIXTURE =
  'var pre=1;' +
  MODULE_LOADER +
  REACT_MODULE +
  CHALK +
  BOX_COMPONENT +
  ';' +
  TEXT_COMPONENT +
  ';' +
  PATCH2_PATH_B +
  JSX_HEADER +
  ';' +
  VERSION_OUTPUT +
  'var post=2;';

// The real 2.1.186 startup banner wraps the header column in a flex ROW whose
// LEFT child is the Clawd logo: R=H.jsxs(BOX,{flexDirection:"row",gap:2,
// alignItems:"center",children:[LOGO, H.jsxs(BOX,{flexDirection:"column",
// children:[Wy,Sy,Ey]})]}). PATCH 3 must wrap that row in a column and put the
// list BELOW it (not inside the header column, which floats the centered logo
// into the middle of the list).
const JSX_BANNER_HEADER =
  'function Bnr(e){' +
  'let Wy;if(e[1]!==d)' +
  'Wy=RC.jsxs(TX,{children:[RC.jsx(TX,{bold:!0,children:"Claude Code"})," ",' +
  'RC.jsxs(TX,{dimColor:!0,children:["v",vv]})]}),e[1]=d,e[2]=Wy;else Wy=e[2];' +
  'let Sy=RC.jsx(TX,{dimColor:!0,children:"sub"}),Ey=null,Lg=RC.jsx(TX,{children:"LOGO"});' +
  'let R;if(e[3]!==Wy)R=RC.jsxs(BX,{flexDirection:"row",gap:2,alignItems:"center",children:[Lg,RC.jsxs(BX,{flexDirection:"column",children:[Wy,Sy,Ey]})]}),e[3]=Wy,e[4]=R;else R=e[4];' +
  'return R}';

const JSX_BANNER_FIXTURE =
  'var pre=1;' +
  MODULE_LOADER +
  REACT_MODULE +
  CHALK +
  BOX_COMPONENT +
  ';' +
  TEXT_COMPONENT +
  ';' +
  PATCH2_PATH_B +
  JSX_BANNER_HEADER +
  ';' +
  VERSION_OUTPUT +
  'var post=2;';

beforeEach(() => {
  // getReactVar memoizes the resolved minified name across calls; clear it so
  // each test resolves against its own fixture.
  clearReactVarCache();
});

describe('findVersionOutputLocation', () => {
  it('locates the }.VERSION} (Claude Code) anchor', () => {
    const loc = findVersionOutputLocation(
      'a=1;help(`${x}.VERSION} (Claude Code)`);b=2;'
    );
    expect(loc).not.toBeNull();
    // endIndex points at the end of the matched `}.VERSION} (Claude Code)` literal
    expect(loc!.endIndex).toBeGreaterThan(loc!.startIndex);
  });

  it('returns null (logging) when the version literal is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      findVersionOutputLocation('function unrelated(){return 1}')
    ).toBeNull();
    errSpy.mockRestore();
  });
});

describe('writePatchesAppliedIndication', () => {
  // PATCH 2's React-compiler header shape and PATCH 3's version-display lookup
  // can't be reproduced in a small synthetic fixture, so they log a graceful
  // "skipped" notice and the function continues. That logging is expected here;
  // silence it so a genuinely new error/warning isn't lost in the noise.
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('appends the tweakcc version to the (Claude Code) version output (PATCH 1)', () => {
    const out = writePatchesAppliedIndication(FIXTURE, '2.0.10', []);
    expect(out).not.toBeNull();
    // PATCH 1 splices the tweakcc marker right after the matched literal.
    expect(out).toContain('}.VERSION} (Claude Code)\\n2.0.10 (tweakcc-fixed)');
  });

  it('patches EVERY occurrence of the version literal (replaceAll)', () => {
    const twice =
      'a=1;`${x}.VERSION} (Claude Code)`;b=`${y}.VERSION} (Claude Code)`;' +
      MODULE_LOADER +
      REACT_MODULE +
      CHALK +
      BOX_COMPONENT +
      ';' +
      TEXT_COMPONENT +
      ';c=2;';
    const out = writePatchesAppliedIndication(twice, '1.2.3', []);
    expect(out).not.toBeNull();
    const occurrences = out!.split('\\n1.2.3 (tweakcc-fixed)').length - 1;
    expect(occurrences).toBe(2);
  });

  it('injects the tweakcc version into the SyK compact header (PATCH 2 Path B)', () => {
    const out = writePatchesAppliedIndication(FIXTURE, '9.9.9', []);
    expect(out).not.toBeNull();
    // Path B rewrites N7("claude",e)(" Claude Code ") to add the marker.
    expect(out).toContain('" Claude Code + tweakcc v9.9.9 "');
  });

  it('does NOT add the SyK marker when showTweakccVersion is false', () => {
    const out = writePatchesAppliedIndication(FIXTURE, '9.9.9', [], false);
    expect(out).not.toBeNull();
    expect(out).not.toContain('+ tweakcc v9.9.9');
    // PATCH 1 still runs regardless of the toggle.
    expect(out).toContain('}.VERSION} (Claude Code)\\n9.9.9 (tweakcc-fixed)');
  });

  it('returns null when the version output anchor is missing', () => {
    // No `}.VERSION} (Claude Code)` literal anywhere — PATCH 1 fails and the
    // whole patch bails out. (console.error is silenced by the block spy.)
    expect(
      writePatchesAppliedIndication('var x=1;function y(){}', '1.0.0', [])
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  // ── CC ≥2.1.186 JSX-runtime header (PATCH 2 / PATCH 3 Method 0) ──────────────
  // CC 2.1.186 moved its header from React.createElement(...) to the JSX runtime
  // (HELPER.jsx / HELPER.jsxs). The createElement-anchored methods no longer
  // match, so each patch grew a JSX method that runs first.

  it('injects the tweakcc marker into the JSX header version row (PATCH 2 Method 0)', () => {
    const out = writePatchesAppliedIndication(JSX_FIXTURE, '3.2.1', []);
    expect(out).not.toBeNull();
    // The marker is appended as one more inline child of the version row's
    // children array, built with the same JSX helper + Text component captured
    // from the header (RC.jsx(TX,{children:CHALK.hex(...).bold("+ tweakcc v…")})).
    expect(out).toContain(
      'RC.jsx(TX,{children:Qc.hex("#FF8400").bold("+ tweakcc v3.2.1")})'
    );
    // It lands inside the version row (right after the inner "v" version group),
    // not as a stray sibling elsewhere.
    expect(out).toContain(
      'RC.jsxs(TX,{dimColor:!0,children:["v",vv]})," ",' +
        'RC.jsx(TX,{children:Qc.hex("#FF8400").bold("+ tweakcc v3.2.1")})]})'
    );
  });

  it('does NOT inject the JSX header marker when showTweakccVersion is false', () => {
    const out = writePatchesAppliedIndication(JSX_FIXTURE, '3.2.1', [], false);
    expect(out).not.toBeNull();
    expect(out).not.toContain('+ tweakcc v3.2.1');
  });

  it('appends the patches list to the JSX header column (PATCH 3 Method 0)', () => {
    const out = writePatchesAppliedIndication(JSX_FIXTURE, '3.2.1', [
      'shrink: 12 fewer chars',
    ]);
    expect(out).not.toBeNull();
    // The list header element is spliced in as the last child of the column Box
    // (flexDirection:"column"), built from the resolved React var + Box + Text.
    expect(out).toContain('\\u2713 tweakcc-fixed patches are applied');
    // The list is inserted as the last child of the [Wy,Sy,Ey] column array,
    // immediately before that array's closing `]` — i.e. after `Ey`.
    expect(out).toContain('children:[Wy,Sy,Ey,');
    // And the per-patch row content rendered through renderPatchListItemRow.
    expect(out).toContain('* shrink: 12 fewer chars');
  });

  it('produces a balanced JSX header after PATCH 2 + PATCH 3 both inject', () => {
    const out = writePatchesAppliedIndication(JSX_FIXTURE, '3.2.1', [
      'demo: 5 fewer chars',
    ]);
    expect(out).not.toBeNull();

    // String-aware bracket/brace/paren balance over the whole patched output.
    // If either injection broke template/quote parity or left an unbalanced
    // delimiter, this nets non-zero and CC's cli.js would fail to parse.
    const balance = (s: string) => {
      let p = 0;
      let b = 0;
      let c = 0;
      let inStr: string | null = null;
      let esc = false;
      for (const ch of s) {
        if (esc) {
          esc = false;
          continue;
        }
        if (inStr) {
          if (ch === '\\') esc = true;
          else if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inStr = ch;
          continue;
        }
        if (ch === '(') p++;
        else if (ch === ')') p--;
        else if (ch === '[') b++;
        else if (ch === ']') b--;
        else if (ch === '{') c++;
        else if (ch === '}') c--;
      }
      return { p, b, c, inStr };
    };

    expect(balance(out!)).toEqual({ p: 0, b: 0, c: 0, inStr: null });
  });

  it('wraps the JSX banner row in a column with the patches list below it (PATCH 3 banner wrap)', () => {
    const out = writePatchesAppliedIndication(JSX_BANNER_FIXTURE, '3.2.1', [
      'shrink: 12 fewer chars',
    ]);
    expect(out).not.toBeNull();
    // The banner row (logo + header) becomes the FIRST child of a wrapping
    // column; the row keeps alignItems:"center" so the logo spans only the
    // header, not the (tall) list.
    expect(out).toContain(
      'R=RC.jsxs(BX,{flexDirection:"column",children:[RC.jsxs(BX,{flexDirection:"row",gap:2,alignItems:"center",children:[Lg,'
    );
    // The header column is untouched ([Wy,Sy,Ey]) — the list did NOT go inside it
    // (inserting it there is what floated the centered logo into the middle).
    expect(out).toContain('flexDirection:"column",children:[Wy,Sy,Ey]})]})');
    expect(out).not.toContain('children:[Wy,Sy,Ey,');
    // The list renders as the row's SIBLING (2nd child of the wrap column).
    expect(out).toContain('\\u2713 tweakcc-fixed patches are applied');
    expect(out).toContain('* shrink: 12 fewer chars');
    // String-aware delimiter balance over the whole output so cli.js still parses.
    let p = 0;
    let b = 0;
    let c = 0;
    let inStr: string | null = null;
    let esc = false;
    for (const ch of out!) {
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (ch === '\\') esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '(') p++;
      else if (ch === ')') p--;
      else if (ch === '[') b++;
      else if (ch === ']') b--;
      else if (ch === '{') c++;
      else if (ch === '}') c--;
    }
    expect({ p, b, c, inStr }).toEqual({ p: 0, b: 0, c: 0, inStr: null });
  });
});

describe('renderPatchListItemRow', () => {
  it('\\uXXXX-escapes non-ASCII in the item so it survives Latin-1 storage', () => {
    const row = renderPatchListItemRow(
      'R',
      'BOX',
      'TXT',
      'Data: Claude API reference — C#: 554 fewer chars'
    );
    // The em-dash must be emitted as an escape, never spliced raw (raw multibyte
    // UTF-8 mojibakes against CC's Latin-1 module storage on Bun-compiled CC).
    expect(row).toContain('* Data: Claude API reference \\u2014 C#');
    expect(row).not.toContain('—');
  });

  it('leaves a fully-ASCII item untouched', () => {
    const row = renderPatchListItemRow(
      'R',
      'BOX',
      'TXT',
      'plain: 3 fewer chars'
    );
    expect(row).toContain('`  * plain: 3 fewer chars`');
  });
});
