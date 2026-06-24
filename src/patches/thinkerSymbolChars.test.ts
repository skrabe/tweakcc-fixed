import { describe, it, expect, vi } from 'vitest';
import { writeThinkerSymbolChars } from './thinkerSymbolChars';

// thinker-symbol-chars replaces CC's spinner symbol-frame arrays — the literal
// list of glyphs the "thinking" animation cycles through. The minified shape is
// a JS array literal of single-glyph strings, e.g. `["·","✢","✳","✶","✻","✽"]`
// (some CC builds emit \uXXXX/\xXX escapes instead of the raw glyph). The patch
// regex matches such arrays (2+ elements) and swaps each for JSON.stringify(symbols).
const FIXTURE = 'var SP=["·","✢","✳","✶","✻","✽"],after=1;';

describe('writeThinkerSymbolChars', () => {
  it('replaces the raw-glyph symbol array with the configured symbols (JSON-encoded)', () => {
    const out = writeThinkerSymbolChars(FIXTURE, ['a', 'b', 'c']);

    expect(out).not.toBeNull();
    // Exact replacement: the whole array literal becomes JSON.stringify(symbols).
    expect(out).toContain('var SP=["a","b","c"],after=1;');
    // Original glyph array is gone.
    expect(out).not.toContain('"✢"');
    expect(out).not.toContain('"✻"');
  });

  it('also matches arrays that use \\uXXXX / \\xXX escape sequences', () => {
    // Some CC builds emit the glyphs as escapes inside the source literal.
    const escaped =
      'q=["\\u00b7","\\u2722","\\u2733","\\u2736","\\u273b","\\u273d"];z=2;';
    const out = writeThinkerSymbolChars(escaped, ['x', 'y']);

    expect(out).not.toBeNull();
    expect(out).toContain('q=["x","y"];z=2;');
    expect(out).not.toContain('\\u2722');
  });

  it('replaces EVERY symbol array when the file contains several', () => {
    const multi = 'a=["·","✢","✳"];mid=0;b=["✶","✻","✽"];end=9;';
    const out = writeThinkerSymbolChars(multi, ['p', 'q']);

    expect(out).not.toBeNull();
    // Both arrays rewritten; surrounding code (mid/end) preserved verbatim.
    expect(out).toBe('a=["p","q"];mid=0;b=["p","q"];end=9;');
  });

  it('JSON-escapes a symbol containing a quote/backslash so output stays valid JS', () => {
    // symbols come from user config — a glyph string carrying a quote or
    // backslash must be escaped by JSON.stringify, not spliced raw.
    const out = writeThinkerSymbolChars(FIXTURE, ['"', '\\', 'ok']);

    expect(out).not.toBeNull();
    // JSON.stringify escapes the quote and backslash.
    expect(out).toContain('["\\"","\\\\","ok"]');
    // The injected array declaration must parse as valid JS.
    expect(
      () => new Function('return ' + out!.slice(7, out!.indexOf('],') + 1))
    ).not.toThrow();
  });

  it('returns null (logging) when no symbol array is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A single-element array does NOT match (regex requires 2+ elements), and
    // unrelated code has no glyphs at all.
    expect(
      writeThinkerSymbolChars('var x=["·"];function y(){}', ['a', 'b'])
    ).toBeNull();
    expect(
      writeThinkerSymbolChars('function unrelated(){return 1}', ['a'])
    ).toBeNull();
    errSpy.mockRestore();
  });
});
