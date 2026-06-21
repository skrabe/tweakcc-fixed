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

// Old CC (<2.1.140): `||3` literal default after the parseInt expression.
const BATCH_FIXTURE_OLD =
  'let $z=parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10)||3;run($z);';

// CC >=2.1.140: parseInt result is stored, then `;return H>0?H:3` clamps it.
const BATCH_FIXTURE_NEW =
  'function gv(){let H=parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10);return H>0?H:3}';

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
    const input = 'x=1;function unrelated(){return 1}y=2;';
    const out = writeMcpNonBlocking(input);
    expect(out).toBe(input);
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

  it('returns null (logging) when the batch-size shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeMcpBatchSize('x=1;function y(){return 2}', 10)).toBeNull();
    errSpy.mockRestore();
  });
});
