import { describe, it, expect, vi } from 'vitest';
import {
  writeConversationTitle,
  enableRenameConversationCommand,
  findCustomNamingFunctionsLocation,
  findAppendEntryInterceptorLocation,
  writeAppendEntryInterceptor,
  findTweakccSummaryCheckLocations,
  writeTweakccSummaryCheck,
} from './conversationTitle';

// conversationTitle adds a `/title` slash command + session-naming plumbing.
// The MODERN path (writeModernTitleCommand, CC 2.x) is what current builds hit:
// it needs a local-command module that exports `performSetColor`/`call` with the
// exact async setColor-call shape, a `var ` sentinel right after it (= moduleEnd),
// and a slash-command list `X=Y(()=>[...])` sitting near name/description metadata.
// This fixture mirrors that shape with realistic '$'-bearing minified names.
const MODULE_BLOCK =
  'var $m0={};AO($m0,{performSetColor:()=>qSet,call:()=>qCall});' +
  'async function $setColorCall(rv,ctx,args){' +
  'return rv(await qFmt(args,ctx),{display:"system"}),null}';
const AFTER_MODULE = 'var $nextThing=1;';
const COMMAND_LIST =
  'xK=L8(()=>[{type:"local",name:"clear",description:"Clear conversation history"},' +
  'UVother,...someSpread?[someSpread]:[],lastCmd])';
const MODERN_FIXTURE = `prefix;${MODULE_BLOCK}${AFTER_MODULE}${COMMAND_LIST};suffix`;

describe('writeConversationTitle (modern path)', () => {
  it('injects the title module + command, reusing the real export-helper name', () => {
    const out = writeConversationTitle(MODERN_FIXTURE);
    expect(out).not.toBeNull();
    // The module is registered via the SAME minified export helper the bundle
    // uses (AO here, not a hardcoded name) — proves exportFn was extracted.
    expect(out).toContain('var tweakccTitleModule={}');
    expect(out).toContain('AO(tweakccTitleModule,{call:()=>tweakccTitleCall})');
    // The /title command definition is spliced into the slash-command array.
    expect(out).toContain('tweakccTitleCommand={type:"local",name:"title"');
    expect(out).toContain('argumentHint:"<title>"');
    expect(out).toContain('context.setAppState?.');
  });

  it('places the command definition INSIDE the command array (before its tail)', () => {
    const out = writeConversationTitle(MODERN_FIXTURE)!;
    // Inserted immediately after the array's `[`, so it precedes the original
    // tail item — i.e. it is a member of the array, not floating after it.
    const cmdIdx = out.indexOf('tweakccTitleCommand=');
    const tailIdx = out.indexOf('lastCmd]');
    expect(cmdIdx).toBeGreaterThan(-1);
    expect(cmdIdx).toBeLessThan(tailIdx);
    // And the command sits right after the opening bracket of `xK=L8(()=>[`.
    expect(out).toContain(
      'xK=L8(()=>[tweakccTitleCommand={type:"local",name:"title"'
    );
  });

  it('emits a terminal-title escape sequence that survives the JS string literal', () => {
    const out = writeConversationTitle(MODERN_FIXTURE)!;
    // The OSC sequence is written as a JS string; the escapes must stay literal
    // backslash-escapes so the generated source parses.
    expect(out).toContain('\\x1B]0;Claude: "+title+"\\x07');
  });

  it('returns null when no recognizable command/module shape is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      writeConversationTitle('totally unrelated minified blob;var x=1;')
    ).toBeNull();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('enableRenameConversationCommand', () => {
  it('flips the gated rename command from disabled (!1) to enabled (!0)', () => {
    const input =
      'a={name:"rename",description:"Rename the current conversation",isEnabled:()=>!1,x:1}';
    const out = enableRenameConversationCommand(input);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'description:"Rename the current conversation",isEnabled:()=>!0,'
    );
    expect(out).not.toContain('isEnabled:()=>!1,');
  });

  it('returns null when the rename command shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(enableRenameConversationCommand('nothing here')).toBeNull();
    errSpy.mockRestore();
  });
});

describe('findCustomNamingFunctionsLocation', () => {
  // class X{summaries;customTitles;messages;checkpoints;fileHistorySnapshots;
  it('locates the session class by its instance-field signature', () => {
    const fix =
      'zzz;class wQ$1{summaries;customTitles;messages;checkpoints;fileHistorySnapshots;constructor(){}}';
    const loc = findCustomNamingFunctionsLocation(fix);
    expect(loc).not.toBeNull();
    expect(fix.slice(loc!)).toMatch(/^class wQ\$1\{summaries;/);
  });

  it('accepts the leaner shape without customTitles/checkpoints fields', () => {
    const fix = 'q;class S9{summaries;messages;fileHistorySnapshots;m(){}}';
    expect(findCustomNamingFunctionsLocation(fix)).not.toBeNull();
  });

  it('returns null when the class signature is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(findCustomNamingFunctionsLocation('no class here')).toBeNull();
    errSpy.mockRestore();
  });
});

describe('append entry interceptor', () => {
  // if(!X.has(msg.uuid)){if(Y.appendFileSync(...
  const FIX =
    'pre;if(!XQ$.has(msg9.uuid)){if(zF.appendFileSync(this.sessionFile,data)){}}post';

  it('finds the insertion point and captures the message variable', () => {
    const r = findAppendEntryInterceptorLocation(FIX);
    expect(r).not.toBeNull();
    expect(r!.messageVar).toBe('msg9');
    // Insertion lands right before the appendFileSync guard (after the has-guard).
    expect(FIX.slice(r!.location)).toMatch(/^if\(zF\.appendFileSync\(/);
  });

  it('injects onNewMessage(...) with the captured message var, keeping the guard intact', () => {
    const out = writeAppendEntryInterceptor(FIX);
    expect(out).not.toBeNull();
    expect(out).toContain('onNewMessage(projectDir, projectSlug, msg9);');
    expect(out).toContain('if(!XQ$.has(msg9.uuid)){const { dirname');
  });

  it('returns null when the append-guard shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(findAppendEntryInterceptorLocation('nope')).toBeNull();
    expect(writeAppendEntryInterceptor('nope')).toBeNull();
    errSpy.mockRestore();
  });
});

describe('tweakcc summary check', () => {
  // for(let f of fileList)try{ ... if(seen.has(msg.uuid))continue; ... }
  const FIX =
    'xx;for(let f9 of fileList$)try{if(seen.has(m7.uuid))continue;doStuff()}catch{}yy';

  it('captures both the file-list loop var and the message var', () => {
    const r = findTweakccSummaryCheckLocations(FIX);
    expect(r).not.toBeNull();
    expect(r!.messageVar).toBe('m7');
    expect(r!.fileListVar).toBe('fileList$');
  });

  it('inserts the summary-set builder and ORs the skip condition with the captured vars', () => {
    const out = writeTweakccSummaryCheck(FIX);
    expect(out).not.toBeNull();
    expect(out).toContain('const tweakccSummaries = new Set();');
    expect(out).toContain('for (const file of fileList$)');
    expect(out).toContain('||tweakccSummaries.has(m7.uuid)');
  });

  it('returns null when the continue-skip loop shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(findTweakccSummaryCheckLocations('nope')).toBeNull();
    expect(writeTweakccSummaryCheck('nope')).toBeNull();
    errSpy.mockRestore();
  });
});
