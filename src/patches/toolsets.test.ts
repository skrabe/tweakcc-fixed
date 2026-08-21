import { describe, it, expect, vi } from 'vitest';
import {
  writeToolsetFieldToAppState,
  getAppStateSelectorAndUseState,
  writeToolFetchingUseMemo,
  writeComputeToolsFilter,
  writePrintToolsFilter,
  findSelectComponentName,
  findModeChange,
  writeModeChangeUpdateToolset,
  appendToolsetToModeDisplay,
  appendToolsetToShortcutsDisplay,
  findToolChangeComponentScope,
  matchDelimiter,
  findStatusLineComponent,
  insertShiftTabAppStateVar,
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

  // CC >=2.1.219: the closure gained a ref-backed memo cache and the agent
  // branch collapsed into a ternary inside a post-filter call. Both exits
  // (cache hit + fresh compute) must be wrapped, and the cache must keep
  // storing the UNFILTERED list so /toolset switches take effect immediately.
  const CT_MEMO =
    ',$up=$NS.useCallback(()=>{let S=$ST.getState(),CH=$rf.current;' +
    'if(CH!==null&&CH.tpc===S.toolPermissionContext&&CH.cit===IN&&CH.mtad===AG)' +
    'return CH.result;side(S.replBridgeEnabled);' +
    'let AS=asm(S.toolPermissionContext,S.mcp.tools,{skillTools:S.skillTools}),' +
    'MG=mrg(IN,AS,S.toolPermissionContext.mode),' +
    'RS=post(AG?rsl(AG,MG,!1,!0).resolvedTools:MG,S.toolPermissionContext);' +
    'return $rf.current={tpc:S.toolPermissionContext,cit:IN,mtad:AG,result:RS},' +
    'RS},[$ST,IN,AG])';
  const MEMO_FIXTURE = APP_STATE + CT_MEMO;

  it('wraps both exits of the CC >=2.1.219 memoized closure', () => {
    const out = writeComputeToolsFilter(MEMO_FIXTURE, TS, 'all')!;
    // The helper is hoisted to the top of the closure body, before the cache
    // hit can return early.
    expect(out).toContain(
      '$up=$NS.useCallback(()=>{const __ts={"readonly":["Read","Grep"],"all":"*"}'
    );
    expect(out).toContain('__tf=(t,s)=>{const n=s.toolset??"all";');
    expect(out).toContain('globalThis.__tweakcc_toolset=');
    expect(out).toContain('if(a==="*")return t');
    // Cache-hit exit and fresh-compute exit are both filtered.
    expect(out).toContain('return __tf(CH.result,S);');
    expect(out).toContain(',__tf(RS,S)},[$ST,IN,AG])');
    // The cache still stores the unfiltered list.
    expect(out).toContain('result:RS}');
    // The unwrapped exits are gone.
    expect(out).not.toContain('return CH.result;');
    expect(out).not.toContain('result:RS},RS}');
  });

  it('escapes a quoted toolset name in the memoized shape too', () => {
    const evil: Toolset[] = [{ name: 'ev"il', allowedTools: ['Read'] }];
    const out = writeComputeToolsFilter(MEMO_FIXTURE, evil, 'ev"il')!;
    expect(out).toContain('"ev\\"il"');
    expect(out).not.toContain('s.toolset??"ev"il"');
  });

  it('prefers the memoized shape but still handles the legacy closure', () => {
    const out = writeComputeToolsFilter(FIXTURE, TS, 'all')!;
    expect(out).toContain('if(!AG)return __tf(MG);');
  });
});

describe('writePrintToolsFilter', () => {
  const body = 'const ctx={tools:$tv,refreshTools:()=>$cf($gs())};' as const;

  it('handles the classic semicolon-terminated declaration', () => {
    const out = writePrintToolsFilter('let $tv=$cf($sv);' + body, TS, 'all')!;
    expect(out).toContain('let $tv=$cf($sv);const __tpts=');
    expect(out).toContain('$tv=__tptf($tv,$sv);');
    expect(out).toContain(
      'refreshTools:()=>{let s=$gs();return __tptf($cf(s),s)}'
    );
  });

  it('reopens the let when the declarator list continues with a comma', () => {
    // CC >=2.1.219: `let TOOLS=COMPUTE(STATE),NEXT=...`
    const out = writePrintToolsFilter(
      'let $tv=$cf($sv),$nx=1;' + body,
      TS,
      'all'
    )!;
    // The trailing declarator keeps its binding form instead of leaking global.
    expect(out).toContain('$tv=__tptf($tv,$sv);let $nx=1;');
    expect(out).toContain('let $tv=$cf($sv);const __tpts=');
    expect(out).toContain(
      'refreshTools:()=>{let s=$gs();return __tptf($cf(s),s)}'
    );
  });

  it('still binds when the declaration is far above its use site', () => {
    // CC 2.1.235 put 2,672 chars of MCP prewait code between `let Hm=ko(Hv),`
    // and `tools:Hm,refreshTools:()=>ko(l())`, which broke a 2500-char window.
    const filler = `if(a){${'/*x*/'.repeat(1200)}}`;
    const out = writePrintToolsFilter(
      'let $tv=$cf($sv);' + filler + body,
      TS,
      'all'
    )!;
    expect(out).toContain('let $tv=$cf($sv);const __tpts=');
    expect(out).toContain('$tv=__tptf($tv,$sv);');
    expect(out).toContain(
      'refreshTools:()=>{let s=$gs();return __tptf($cf(s),s)}'
    );
  });

  // CC 2.1.238 split the print path: the arrows are hoisted into named consts,
  // `tools:` and `refreshTools:` take the SAME thunk on the lazy branch, and the
  // eager array the non-SDK branch submits moved to its own declaration. Both
  // sites must be filtered, and both splices must be pure EXPRESSIONS — each one
  // is a declarator inside a `let` list, so a `const` statement in front of
  // either closes the list mid-declarator and yields JS Bun cannot parse.
  const split238 =
    'let $bu={a:1},$th=()=>$cf($gs()),$mc=()=>$mk($gs()),$cs={session:$e,refreshTools:$th,refreshMcpClients:$mc,verbose:1};' +
    'let $fm=$mk($sv);let $tv=$cf($sv),$a5=2;' +
    'Q??=ICy({...$cs,tools:$th,mcpClients:$mc,appendSystemPrompt:1});' +
    'ACy({...$cs,tools:$tv,mcpClients:$fm,appendSystemPrompt:1});';

  it('filters both sites of the CC 2.1.238 split print path', () => {
    const out = writePrintToolsFilter(split238, TS, 'all')!;
    expect(out).not.toBeNull();
    // the shared thunk (covers tools: on the lazy branch AND refreshTools:)
    expect(out).toContain('$th=()=>{let s=$gs();return ((t,s)=>{const p=');
    // the eager array the non-SDK branch submits
    expect(out).toContain('$tv=((t,s)=>{const p=');
    expect(out).toContain('})($cf($sv),$sv)');
    // no statement was spliced into a declarator list
    expect(out).not.toContain('const __tpts=');
  });

  it('emits parseable JS for the CC 2.1.238 split print path', () => {
    const out = writePrintToolsFilter(split238, TS, 'all')!;
    expect(
      () => new Function(out.replace(/Q\?\?=/, 'globalThis.Q??='))
    ).not.toThrow();
  });

  it('returns null when the print tools init is absent', () => {
    const err = silenceErr();
    expect(writePrintToolsFilter('x=1', TS, 'all')).toBeNull();
    err.mockRestore();
  });

  it('returns null when the use site is present but never declared', () => {
    const err = silenceErr();
    expect(writePrintToolsFilter(body, TS, 'all')).toBeNull();
    err.mockRestore();
  });
});

describe('findSelectComponentName', () => {
  it('extracts the Select component name from its createElement signature', () => {
    const input =
      'q=$R.createElement($Sel,{a:1},"Yes, use recommended settings");';
    expect(findSelectComponentName(input)).toBe('$Sel');
  });

  it('extracts the Select component name from the CC >=2.1.186 jsx call', () => {
    const input =
      'q=$Mb.jsx($Sel,{confirmLabel:"Yes, use recommended settings",b:1});';
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

// ----------------------------------------------------------------------------
// CC >=2.1.204 status line (React-compiler memoized).
//
// The mode label and the "? for shortcuts" hint live in ONE compiler-memoized
// component (`function ctl(LpI){let bm=wOn.c(143),...`), while the shell-mode
// hint the old anchor keyed on moved ~1.1 MB away into a different component.
// Steps 5-7 must therefore all target this body: step 5 declares
// `currentToolset` in it, steps 6/7 read that binding.
// ----------------------------------------------------------------------------
const STATUS_LINE =
  'function ctl($L){let bm=wOn.c(143),{mode:$m}=$L;' +
  'let uI;if(kR==="shortcuts")uI=Ln.jsx(h,{dimColor:!0,children:"? for shortcuts"});' +
  'let xX;if(bm[35]!==dne||bm[36]!==EWf)xX=Ln.jsxs(h,{children:[Que(dne)," on",EWf]},"mode"),' +
  'bm[35]=dne,bm[36]=EWf,bm[38]=xX;else xX=bm[38];' +
  'let Jjt;if(bm[83]!==dne||bm[86]!==yWf)Jjt=Ln.jsxs(h,{children:[Que(dne)," on",bOn]},"mode"),' +
  'bm[83]=dne,bm[86]=yWf,bm[87]=Jjt;else Jjt=bm[87];' +
  'let LCe;if(bm[115]===J)LCe=Ln.jsx(h,{children:"? for shortcuts"},"shortcuts-hint"),bm[115]=LCe;' +
  'else LCe=bm[115];return xX}';

// A different compiler component that also renders the hint — it must be left
// alone, since `currentToolset` is not in scope there.
const OTHER_COMPONENT =
  'function zz($q){let mm=nn.c(4),ww=1;return or.jsx(h,{children:"? for shortcuts"})}';

const STATUS_LINE_FILE = APP_STATE + STATUS_LINE + OTHER_COMPONENT;

describe('matchDelimiter', () => {
  it('ignores braces inside strings, templates, comments and regexes', () => {
    const src = 'f(){let a="}",b=`x${{y:1}}`,c=/[}]/,d;/*}*/}';
    const open = src.indexOf('{');
    expect(matchDelimiter(src, open)).toBe(src.length - 1);
  });

  it('returns null when the delimiter never closes', () => {
    expect(matchDelimiter('f(){a', 3)).toBeNull();
    expect(matchDelimiter('abc', 1)).toBeNull();
  });
});

describe('findStatusLineComponent', () => {
  it('locates the memoized component owning the mode + shortcuts labels', () => {
    const comp = findStatusLineComponent(STATUS_LINE_FILE)!;
    expect(comp.name).toBe('ctl');
    expect(comp.cacheVar).toBe('bm');
    const body = STATUS_LINE_FILE.slice(comp.bodyStart, comp.bodyEnd);
    expect(body.startsWith('let bm=wOn.c(143)')).toBe(true);
    // The competing component sits entirely outside the span.
    expect(body).not.toContain('or.jsx');
  });

  it('re-locates the component from the injected declaration alone', () => {
    // Steps 6/7 rewrite the mode label, destroying the discovery anchor — the
    // `let currentToolset=` declaration has to keep the component findable.
    const injected = insertShiftTabAppStateVar(STATUS_LINE_FILE, 'ro')!;
    const rewritten = appendToolsetToModeDisplay(injected)!;
    expect(rewritten).not.toContain('," on"');
    const comp = findStatusLineComponent(rewritten)!;
    expect(comp.name).toBe('ctl');
  });

  it('returns null when no compiler component renders a mode label', () => {
    expect(findStatusLineComponent('var a=1;')).toBeNull();
  });
});

describe('insertShiftTabAppStateVar', () => {
  it('declares currentToolset at the top of the status line component', () => {
    const out = insertShiftTabAppStateVar(STATUS_LINE_FILE, 'readonly')!;
    expect(out).toContain(
      'function ctl($L){let currentToolset=D8(state => state.toolset) ?? "readonly";let bm=wOn.c(143)'
    );
  });

  it('is idempotent', () => {
    const once = insertShiftTabAppStateVar(STATUS_LINE_FILE, 'readonly')!;
    expect(insertShiftTabAppStateVar(once, 'readonly')).toBe(once);
  });

  it('falls back to the pre-2.1.204 shell-mode anchor', () => {
    const legacy =
      APP_STATE +
      'function QQ(T){z=or.createElement(k,{color:"bashBorder"},"! for shell mode")}';
    const out = insertShiftTabAppStateVar(legacy, null)!;
    expect(out).toContain(
      'function QQ(T){let currentToolset=D8(state => state.toolset) ?? undefined;'
    );
  });

  it('returns null when neither anchor is present', () => {
    const err = silenceErr();
    expect(insertShiftTabAppStateVar(APP_STATE, null)).toBeNull();
    err.mockRestore();
  });
});

describe('appendToolsetToModeDisplay (CC >=2.1.204)', () => {
  it('rewrites every mode label in the component and widens the memo guards', () => {
    const out = appendToolsetToModeDisplay(STATUS_LINE_FILE)!;
    expect(out).not.toContain('," on"');
    expect(
      out.match(
        /Que\(dne\),currentToolset\?` on \[\$\{currentToolset\}\]`:" on"/g
      )
    ).toHaveLength(2);
    // A guard that does not compare currentToolset would keep serving the
    // element built for the previous toolset.
    expect(out).toContain('if(bm[35]!==dne||bm[36]!==EWf||!0)');
    expect(out).toContain('if(bm[83]!==dne||bm[86]!==yWf||!0)');
  });

  it('is idempotent once the declaration anchor exists', () => {
    const injected = insertShiftTabAppStateVar(STATUS_LINE_FILE, 'readonly')!;
    const once = appendToolsetToModeDisplay(injected)!;
    expect(appendToolsetToModeDisplay(once)).toBe(once);
  });
});

describe('appendToolsetToShortcutsDisplay (CC >=2.1.204)', () => {
  it('rewrites only the hints inside the status line component', () => {
    const out = appendToolsetToShortcutsDisplay(STATUS_LINE_FILE)!;
    expect(
      out.match(
        /currentToolset\?`\? for shortcuts \[\$\{currentToolset\}\]`:"\? for shortcuts"/g
      )
    ).toHaveLength(2);
    // The component that cannot see `currentToolset` is untouched.
    expect(out).toContain('or.jsx(h,{children:"? for shortcuts"})');
    // The compute-once sentinel guard is widened too.
    expect(out).toContain('if(bm[115]===J||!0)');
  });

  it('is idempotent once the declaration anchor exists', () => {
    const injected = insertShiftTabAppStateVar(STATUS_LINE_FILE, 'readonly')!;
    const once = appendToolsetToShortcutsDisplay(injected)!;
    expect(appendToolsetToShortcutsDisplay(once)).toBe(once);
  });
});

describe('findToolChangeComponentScope', () => {
  it('accepts the pre-2.1.219 statement-terminated shape', () => {
    const src =
      'a=1;jai(I,function(Wt){M("tengu_ext_at_mentioned",{});eQ(x)});';
    expect(findToolChangeComponentScope(src)).toBe(src.indexOf('jai('));
  });

  it('accepts the CC >=2.1.219 sequence-expression shape', () => {
    // The following statement folded into a comma expression.
    const src =
      'a=1;Wai(I,function(Wt){M("tengu_ext_at_mentioned",{}),eQ(Gai(Wt))});';
    expect(findToolChangeComponentScope(src)).toBe(src.indexOf('Wai('));
  });

  it('returns null when the at-mention handler is absent', () => {
    const err = silenceErr();
    expect(findToolChangeComponentScope('var a=1;')).toBeNull();
    err.mockRestore();
  });
});
