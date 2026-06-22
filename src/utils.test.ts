import { describe, it, expect } from 'vitest';
import {
  readResponseTextCapped,
  MAX_FETCH_BYTES,
  escapeNonAscii,
} from './utils';

describe('escapeNonAscii', () => {
  // Keep backslashes out of string literals (via fromCharCode) so these
  // assertions are unambiguous about the exact escaped bytes produced.
  const BS = String.fromCharCode(92); // a single backslash

  it('leaves ASCII untouched, including pre-existing unicode escapes', () => {
    const s = 'plain ascii * 123 ' + BS + 'u2500';
    expect(escapeNonAscii(s)).toBe(s);
  });

  it('escapes the mojibake-causing BMP glyphs', () => {
    // U+2503 ┃, U+2713 ✓, U+273B ✻, U+2026 …, U+00E9 é
    const input = String.fromCharCode(0x2503, 0x2713, 0x273b, 0x2026, 0xe9);
    const expected =
      BS + 'u2503' + BS + 'u2713' + BS + 'u273b' + BS + 'u2026' + BS + 'u00e9';
    expect(escapeNonAscii(input)).toBe(expected);
  });

  it('escapes each surrogate half of an astral codepoint', () => {
    expect(escapeNonAscii(String.fromCodePoint(0x1f600))).toBe(
      BS + 'ud83d' + BS + 'ude00'
    );
  });

  it('produces pure ASCII that parses back to the original string', () => {
    const original =
      'spinner ' +
      String.fromCharCode(0x273b) +
      ' done' +
      String.fromCharCode(0x2026) +
      ' caf' +
      String.fromCharCode(0xe9);
    const out = escapeNonAscii(original);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
    expect(JSON.parse('"' + out + '"')).toBe(original);
  });
});

describe('readResponseTextCapped', () => {
  it('returns the body when it is under the cap', async () => {
    const out = await readResponseTextCapped(new Response('hello world'), 1024);
    expect(out).toBe('hello world');
  });

  it('reads a body exactly at the cap', async () => {
    const body = 'x'.repeat(100);
    const out = await readResponseTextCapped(new Response(body), 100);
    expect(out).toBe(body);
  });

  it('aborts a streamed body that exceeds the cap', async () => {
    // No Content-Length here, so this exercises the streaming-abort path.
    await expect(
      readResponseTextCapped(new Response('x'.repeat(5000)), 100)
    ).rejects.toThrow(/exceeds the 100-byte limit/);
  });

  it('fast-rejects an oversized Content-Length without reading the body', async () => {
    const r = new Response('tiny', {
      headers: { 'content-length': '999999' },
    });
    await expect(readResponseTextCapped(r, 100)).rejects.toThrow(/too large/);
  });

  it('defaults to a generous 32 MB cap', () => {
    expect(MAX_FETCH_BYTES).toBe(32 * 1024 * 1024);
  });
});
