import { describe, it, expect, vi } from 'vitest';
import {
  writeToolsetFieldToAppState,
  getAppStateSelectorAndUseState,
  writeToolFetchingUseMemo,
  writeComputeToolsFilter,
  findSelectComponentName,
  findModeChange,
  writeModeChangeUpdateToolset,
  appendToolsetToModeDisplay,
  appendToolsetToShortcutsDisplay,
} from './toolsets';
import type { Toolset } from '../types';

// ----------------------------------------------------------------------------
// Shared synthetic app-state fixture.
//
// Several sub-patches call getAppStateSelectorAndUseState(). The CC >=2.1.83
// shape it discovers is:
//   function SETSTATE(){return STORE().setState}
//   function SELECTOR(A){...STORE()...useSyncExternalStore(...)}
//   SELECTOR(...thinkingEnabled...)   // verification anchor
// The '$'-bearing store name ($St) exercises the patch's regex-escaping of '$'.
// ----------------------------------------------------------------------------
const APP_STATE =
  'function iA(){return $St().setState}' +
  'function D8(A){let q=$St(),r=Pc.useSyncExternalStore(a,b);return r}' +
  'D8(z).thinkingEnabled;';

const silenceErr = () =>
  vi.spyOn(console, 'error').mockImplementation(() => {});

const TS: Toolset[] = [
  { name: 'readonly', allowedTools: ['Read', 'Grep'] },
  { name: 'all', allowedTools: '*' },
];

describe('getAppStateSelectorAndUseState', () => {
  it('finds the selector + setState fns in the CC >=2.1.83 shape', () => {
    const info = getAppStateSelectorAndUseState(APP_STATE);
    expect(info).toEqual({
      appStateUseSelectorFn: 'D8',
      appStateSetState: 'iA',
    });
  });

  it('finds the selector + setState fns in the CC <2.1.83 shape', () => {
    // function D8(...`Your selector in...function iA(){return ST().setState}
    const old =
      'function D8(A){let q=`Your selector in something`;return q}' +
      'function iA(){return ST().setState}';
    expect(getAppStateSelectorAndUseState(old)).toEqual({
      appStateUseSelectorFn: 'D8',
      appStateSetState: 'iA',
    });
  });

  it('returns null when no app-state store is present', () => {
    const err = silenceErr();
    expect(getAppStateSelectorAndUseState('function y(){return 1}')).toBeNull();
    err.mockRestore();
  });
});

describe('writeToolsetFieldToAppState', () => {
  it('inserts a JSON-quoted toolset field after every thinkingEnabled:X()', () => {
    const input = 'a={thinkingEnabled:k1()};b={thinkingEnabled:k2()};';
    const out = writeToolsetFieldToAppState(input, 'readonly');
    expect(out).toBe(
      'a={thinkingEnabled:k1(),toolset:"readonly"};' +
        'b={thinkingEnabled:k2(),toolset:"readonly"};'
    );
  });

  it('emits the literal undefined (not a string) when no default toolset', () => {
    const out = writeToolsetFieldToAppState('x={thinkingEnabled:k()}', null);
    expect(out).toBe('x={thinkingEnabled:k(),toolset:undefined}');
  });

  it('JSON-escapes a malicious default-toolset name (config is untrusted)', () => {
    // settings.misc default toolset names are reachable via --config-url, so a
    // quote/backslash must not break out of the toolset:"..." literal.
    const evil = 'ev"il\\x';
    const out = writeToolsetFieldToAppState('x={thinkingEnabled:k()}', evil)!;
    expect(out).toContain(`toolset:${JSON.stringify(evil)}`);
    expect(out).not.toContain(`toolset:"${evil}"`);
    const lit = out.match(/toolset:("(?:[^"\\]|\\.)*")/)![1];
    expect(() => JSON.parse(lit)).not.toThrow();
  });

  it('returns null when no thinkingEnabled site exists', () => {
    const err = silenceErr();
    expect(writeToolsetFieldToAppState('nothing here', 'readonly')).toBeNull();
    err.mockRestore();
  });
});

describe('writeToolFetchingUseMemo', () => {
  // tool aggregation site: let VAR=FN(arg,arg.tools,arg),
  const AGG = 'let $tp=Gm($a,$b.tools,$c),next=1;';
  const FIXTURE = APP_STATE + AGG;

  it('wraps the aggregation in a toolset filter keyed off the selector', () => {
    const out = writeToolFetchingUseMemo(FIXTURE, TS, 'readonly')!;
    // currentToolset comes from the discovered selector fn (D8) + default.
    expect(out).toContain(
      'let currentToolset = D8(state => state.toolset) ?? "readonly";'
    );
    // The toolsets map is emitted as JSON and consulted with hasOwnProperty.
    expect(out).toContain(
      'const toolsets = {"readonly":["Read","Grep"],"all":"*"};'
    );
    expect(out).toContain('if (toolsets.hasOwnProperty(currentToolset))');
    // The '*' branch keeps the full aggregation; the else filters by name.
    expect(out).toContain('$tp = Gm($a,$b.tools,$c);');
    expect(out).toContain(
      '$tp = Gm($a,$b.tools,$c).filter((toolDef) => allowedTools.includes(toolDef.name));'
    );
  });

  it('returns null when the aggregation site is absent', () => {
    const err = silenceErr();
    expect(writeToolFetchingUseMemo(APP_STATE, TS, 'readonly')).toBeNull();
    err.mockRestore();
  });
});

describe('writeComputeToolsFilter', () => {
  // computeTools closure (old, non-useCallback form).
  const CT =
    '$ct=()=>{let S=$ST.getState(),' +
    'AS=asm(S.toolPermissionContext,S.mcp.tools),' +
    'MG=mrg(IN,AS,S.toolPermissionContext.mode);' +
    'if(!AG)return MG;return rsl(AG,MG,!1,!0).resolvedTools}';
  const FIXTURE = APP_STATE + CT;

  it('rewrites computeTools to filter both return paths through the toolset', () => {
    const out = writeComputeToolsFilter(FIXTURE, TS, 'all')!;
    // Records the active toolset on globalThis for the error helper.
    expect(out).toContain('globalThis.__tweakcc_toolset=');
    // Reads the toolset straight from the store state in this closure.
    expect(out).toContain('__tc=S.toolset??"all"');
    // The '*' fast-path and the .filter restriction are both present.
    expect(out).toContain('if(a==="*")return t');
    expect(out).toContain('t.filter(d=>a.includes(d.name))');
    // Both original returns are wrapped in __tf(...).
    expect(out).toContain('if(!AG)return __tf(MG);');
    expect(out).toContain('return __tf(rsl(AG,MG,!1,!0).resolvedTools)');
    // The original unfiltered closure body is gone.
    expect(out).not.toContain('if(!AG)return MG;return rsl(AG,MG,!1,!0)');
  });

  it('JSON-escapes a toolset name with a quote so the closure stays valid JS', () => {
    const evil: Toolset[] = [{ name: 'ev"il', allowedTools: ['Read'] }];
    const out = writeComputeToolsFilter(FIXTURE, evil, 'ev"il')!;
    // The embedded map + fallback are valid JS string literals.
    expect(out).toContain('"ev\\"il"');
    expect(out).not.toContain('__tc=S.toolset??"ev"il"');
  });

  it('returns null when the computeTools closure is absent', () => {
    const err = silenceErr();
    expect(writeComputeToolsFilter(APP_STATE, TS, 'all')).toBeNull();
    err.mockRestore();
  });
});

describe('findSelectComponentName', () => {
  it('extracts the Select component name from its createElement signature', () => {
    const input =
      'q=$R.createElement($Sel,{a:1},"Yes, use recommended settings");';
    expect(findSelectComponentName(input)).toBe('$Sel');
  });

  it('returns null when the Select signature is absent', () => {
    const err = silenceErr();
    expect(findSelectComponentName('createElement(X,{})')).toBeNull();
    err.mockRestore();
  });
});

describe('findModeChange / writeModeChangeUpdateToolset', () => {
  const MODE =
    'if($s(($p)=>({...$p,toolPermissionContext:' +
    '{...$p.toolPermissionContext,mode:$md}})))';

  it('finds the mode var and the setState var', () => {
    const r = findModeChange(MODE)!;
    expect(r.setStateVar).toBe('$s');
    expect(r.modeVar).toBe('$md');
    expect(r.index).toBe(0);
  });

  it('injects a plan/default toolset switch before the mode change', () => {
    const out = writeModeChangeUpdateToolset(MODE, 'plan-only', 'readonly')!;
    expect(out).toContain(
      'if($md==="plan"){$s((prev)=>({...prev,toolset:"plan-only"}));}' +
        'else{$s((prev)=>({...prev,toolset:"readonly"}));}'
    );
    // The injection sits before the original mode-change expression.
    expect(out.indexOf('toolset:"plan-only"')).toBeLessThan(
      out.indexOf('if($s(')
    );
  });

  it('JSON-escapes plan/default toolset names with quotes', () => {
    const out = writeModeChangeUpdateToolset(MODE, 'pl"an', 'de"f')!;
    expect(out).toContain('toolset:"pl\\"an"');
    expect(out).toContain('toolset:"de\\"f"');
  });

  it('returns null when no mode-change site exists', () => {
    const err = silenceErr();
    expect(findModeChange('x=1')).toBeNull();
    expect(writeModeChangeUpdateToolset('x=1', 'a', 'b')).toBeNull();
    err.mockRestore();
  });
});

describe('appendToolsetToModeDisplay', () => {
  it('rewrites the " on" mode label to show the current toolset', () => {
    const out = appendToolsetToModeDisplay('z=$tl($Y).toLowerCase()," on";')!;
    expect(out).toContain(
      '$tl($Y).toLowerCase(),currentToolset?` on [${currentToolset}]`:""'
    );
    expect(out).not.toContain('.toLowerCase()," on"');
  });

  it('returns null when the mode label is absent', () => {
    const err = silenceErr();
    expect(appendToolsetToModeDisplay('nope')).toBeNull();
    err.mockRestore();
  });
});

describe('appendToolsetToShortcutsDisplay', () => {
  it('rewrites the LAST "? for shortcuts" to include the toolset', () => {
    // Two occurrences exist in some CC builds; only the last is rewritten.
    const input = 'a,"? for shortcuts",b,"? for shortcuts",c';
    const out = appendToolsetToShortcutsDisplay(input)!;
    expect(out).toContain(
      'currentToolset?`? for shortcuts [${currentToolset}]`:"? for shortcuts"'
    );
    // The earlier occurrence is left untouched (only one raw literal remains).
    expect(out.match(/"\? for shortcuts",b/)).not.toBeNull();
  });

  it('returns null when the shortcuts label is absent', () => {
    const err = silenceErr();
    expect(appendToolsetToShortcutsDisplay('nope')).toBeNull();
    err.mockRestore();
  });
});
