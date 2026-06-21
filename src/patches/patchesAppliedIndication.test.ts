import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findVersionOutputLocation,
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
const CHALK =
  'Qc.hex("#FF8400").bold("a");Qc.blue.bold("b");Qc.green("c");';

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
    expect(findVersionOutputLocation('function unrelated(){return 1}')).toBeNull();
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
});
