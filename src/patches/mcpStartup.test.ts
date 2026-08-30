import { describe, it, expect, vi } from 'vitest';
import { writeMcpNonBlocking, writeMcpBatchSize } from './mcpStartup';

// mcpStartup tweaks two MCP-connection knobs in cli.js:
//   - writeMcpNonBlocking: rewrites `!IDENT(process.env.MCP_CONNECTION_NONBLOCKING)`
//     to the literal `false`, forcing non-blocking MCP startup.
//   - writeMcpBatchSize: bumps the parallel-connection batch-size default (the
//     trailing digit) in the parseInt(...MCP_SERVER_CONNECTION_BATCH_SIZE...) expr.
//
// NONBLOCKING_FIXTURE mirrors the pre-2.1.79 shape where a guard function wraps
// the env read: `if(!Q9(process.env.MCP_CONNECTION_NONBLOCKING)){...}`.
const NONBLOCKING_FIXTURE =
  'a=1;if(!Q9(process.env.MCP_CONNECTION_NONBLOCKING)){await $blockOnMcp()}b=2;';

// CC >=2.1.251: parsed settings object. `!==!1` is true unless the setting is
// explicitly false (unset defaults to nonblocking). The export-map mention
// must stay untouched. `$e` proves the object name is `[$\w]+`, not `\w+`.
const NONBLOCKING_FIXTURE_251 =
  'q=lr(),z=$e.MCP_CONNECTION_NONBLOCKING!==!1;Fkn(z);let se=z,' +
  'MCP_CONNECTION_NONBLOCKING:()=>Vc,';

// Old CC (<2.1.140): `||3` literal default after the parseInt expression.
const BATCH_FIXTURE_OLD =
  'let $z=parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10)||3;run($z);';

// CC >=2.1.140: parseInt result is stored, then `;return H>0?H:3` clamps it.
const BATCH_FIXTURE_NEW =
  'function gv(){let H=parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10);return H>0?H:3}';

// CC >=2.1.219: the parseInt moved into a shared numeric-env helper, so the
// `||"",10)` anchor is gone. Verbatim shape from the 2.1.220 bundle, where the
// helper appears twice (both copies must be rewritten). The neighbouring
// MCP_REMOTE_... helper (default 20) must stay untouched.
const BATCH_FIXTURE_HELPER =
  'function iKu(){let e=Bd(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE);return e>0?e:3}' +
  'function sKu(){let e=Bd(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE);return e>0?e:20}' +
  'function OYu(){let $Rg=Bd(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE);return $Rg>0?$Rg:3}';

// CC >=2.1.251: nullish coalesce on a settings object; two copies of the
// helper (both must be rewritten). Neighbouring remote helper (default 20)
// and the export-map mention must stay untouched.
const BATCH_FIXTURE_NULLISH =
  'MCP_SERVER_CONNECTION_BATCH_SIZE:()=>gp,' +
  'function Dr(){return a.MCP_SERVER_CONNECTION_BATCH_SIZE??3}' +
  'function xr(){return a.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE??20}' +
  'function Ro(){return $a.MCP_SERVER_CONNECTION_BATCH_SIZE??3}';

describe('writeMcpNonBlocking', () => {
  it('replaces the blocking guard call with the literal false', () => {
    const out = writeMcpNonBlocking(NONBLOCKING_FIXTURE);
    expect(out).not.toBeNull();
    // The whole `!Q9(process.env.MCP_CONNECTION_NONBLOCKING)` becomes `false`.
    expect(out).toContain('a=1;if(false){await $blockOnMcp()}b=2;');
    expect(out).not.toContain('MCP_CONNECTION_NONBLOCKING');
  });

  it('is a no-op (returns the file unchanged) when the env var was removed (CC >=2.1.79)', () => {
    // No error/null here by design: non-blocking became the default upstream,
    // so the absence of the guard is expected, not a failure.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const input = 'x=1;function unrelated(){return 1}y=2;';
    const out = writeMcpNonBlocking(input);
    expect(out).toBe(input);
    expect(logSpy).toHaveBeenCalledWith(
      'patch: mcp-non-blocking: feature already promoted in this CC build — no-op'
    );
    logSpy.mockRestore();
  });

  it('forces the CC >= 2.1.251 settings-object flag on', () => {
    const out = writeMcpNonBlocking(NONBLOCKING_FIXTURE_251);
    expect(out).not.toBeNull();
    expect(out).toContain('q=lr(),z=true;Fkn(z);let se=z,');
    // Export-map mention is not a check and must survive.
    expect(out).toContain('MCP_CONNECTION_NONBLOCKING:()=>Vc,');
  });

  it('fails loud when the env name survives but no known check shape matches', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeMcpNonBlocking('MCP_CONNECTION_NONBLOCKING:()=>Vc,other=1')
    ).toBeNull();
    errSpy.mockRestore();
  });
});

describe('writeMcpBatchSize', () => {
  it('bumps the old `||3` default to the requested batch size', () => {
    const out = writeMcpBatchSize(BATCH_FIXTURE_OLD, 12);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10)||12;'
    );
    // Only the trailing default digit changed, not the rest of the expression.
    expect(out).not.toContain('||3;');
  });

  it('bumps the CC >=2.1.140 `return H>0?H:3` default', () => {
    const out = writeMcpBatchSize(BATCH_FIXTURE_NEW, 8);
    expect(out).not.toBeNull();
    expect(out).toContain('return H>0?H:8}');
    expect(out).not.toContain('return H>0?H:3');
  });

  it('only touches the captured default, leaving the parseInt expression intact', () => {
    const out = writeMcpBatchSize(BATCH_FIXTURE_NEW, 8)!;
    // The parseInt read of the env var must survive untouched.
    expect(out).toContain(
      'parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10);'
    );
    // The clamp variable H must be preserved on both sides of the ternary.
    expect(out).toContain('return H>0?H:8}');
  });

  it('coerces a multi-digit value correctly (replaces the whole default token)', () => {
    const out = writeMcpBatchSize(BATCH_FIXTURE_OLD, 100)!;
    expect(out).toContain('10)||100;');
  });

  it('bumps the CC >=2.1.219 helper-fn default at every occurrence', () => {
    const out = writeMcpBatchSize(BATCH_FIXTURE_HELPER, 12);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function iKu(){let e=Bd(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE);return e>0?e:12}'
    );
    // Second copy of the helper in the bundle — minified name contains `$`,
    // which a String.replace-based splice would mangle.
    expect(out).toContain(
      'function OYu(){let $Rg=Bd(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE);return $Rg>0?$Rg:12}'
    );
    // The remote-server helper keeps its own default of 20.
    expect(out).toContain(
      'process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE);return e>0?e:20}'
    );
    expect(out).not.toContain(':3}');
  });

  it('leaves the env-name export map alone (no bare-name rewrite)', () => {
    // The bundle also mentions the env var in an export map and a string set;
    // neither has the `);return X>0?X:N` clamp, so neither may be touched.
    const input =
      'MCP_SERVER_CONNECTION_BATCH_SIZE:()=>Luh,MCP_SDK_GENERATION:()=>Muh,' +
      'function iKu(){let e=Bd(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE);return e>0?e:3}';
    const out = writeMcpBatchSize(input, 9)!;
    expect(out).toContain('MCP_SERVER_CONNECTION_BATCH_SIZE:()=>Luh,');
    expect(out).toContain('return e>0?e:9}');
  });

  it('returns null (logging) when the batch-size shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeMcpBatchSize('x=1;function y(){return 2}', 10)).toBeNull();
    errSpy.mockRestore();
  });

  it('bumps the CC >= 2.1.251 nullish-coalesce default at every occurrence', () => {
    const out = writeMcpBatchSize(BATCH_FIXTURE_NULLISH, 12);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function Dr(){return a.MCP_SERVER_CONNECTION_BATCH_SIZE??12}'
    );
    expect(out).toContain(
      'function Ro(){return $a.MCP_SERVER_CONNECTION_BATCH_SIZE??12}'
    );
    expect(out).toContain('a.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE??20}');
    expect(out).toContain('MCP_SERVER_CONNECTION_BATCH_SIZE:()=>gp,');
    expect(out).not.toContain('??3}');
  });
});
