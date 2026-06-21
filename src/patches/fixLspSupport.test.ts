import { describe, it, expect, vi } from 'vitest';
import { writeFixLspSupport } from './fixLspSupport';

// fix-lsp-support runs on every apply (no condition). Two parts: strip the
// "is not yet implemented" validation throws (globalReplace, silent on no-match),
// and inject a textDocument/didOpen notification UNLESS didOpen is already native
// (CC >= 2.1.87, the 2.1.183 production path).
const throwFor = (field: string) =>
  `if(cfg.${field}!==void 0)throw Error(\`LSP server '\${nm}': ${field} is not yet implemented. Remove this field from the configuration.\`);`;

// Legacy (pre-2.1.87) shape with no native didOpen, enough structure for
// getOpenDocumentLocation to resolve docPathVar (dp) + serverVar (s).
const INJECT_FIXTURE =
  'async function Q(dp,o){let s=await mk(c);if(!s)return;doStuff()}' +
  'var api={sendRequest:Q,ensureServerStarted:E};';

describe('writeFixLspSupport', () => {
  it('strips the not-yet-implemented validation throws (didOpen native -> no inject)', () => {
    const input =
      'A;' +
      throwFor('restartOnCrash') +
      throwFor('startupTimeout') +
      throwFor('shutdownTimeout') +
      'B;"textDocument/didOpen";C;';

    const out = writeFixLspSupport(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('is not yet implemented');
    // the rest of the file (incl. the native didOpen) is preserved
    expect(out).toContain('"textDocument/didOpen"');
  });

  it('is a no-op when didOpen is native and there are no throws', () => {
    const input = 'x=1;"textDocument/didOpen";y=2;';
    expect(writeFixLspSupport(input)).toBe(input);
  });

  it('injects the didOpen notification on legacy builds without native didOpen', () => {
    const out = writeFixLspSupport(INJECT_FIXTURE);

    expect(out).not.toBeNull();
    // injected after if(!s)return;, using the resolved doc-path + server vars
    expect(out).toContain("s.sendNotification('textDocument/didOpen'");
    expect(out).toContain('path.extname(dp)');
  });

  it('returns null when didOpen is absent and the server structure is not found', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeFixLspSupport('const x=1;function y(){}')).toBeNull();
    errSpy.mockRestore();
  });
});
