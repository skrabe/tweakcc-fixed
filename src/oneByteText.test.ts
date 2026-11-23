import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { oneByteText } from './oneByteText';
import { escapeNonAscii } from './utils';
import { MutableText } from './mutableText';

v8.setFlagsFromString('--allow-natives-syntax');
const haveSameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)') as (
  a: string,
  b: string
) => boolean;
const oneByteReference = Buffer.from('reference text', 'latin1').toString(
  'latin1'
);
const asciiHeldTwoByte = ('—' + 'plain ascii text '.repeat(4)).slice(1);

describe('oneByteText', () => {
  it('keeps the characters of ASCII, Latin-1 and wider text', () => {
    for (const text of ['', 'abc', 'café × 2', asciiHeldTwoByte]) {
      expect(oneByteText(text)).toBe(text);
    }
  });

  it('returns text with a character above U+00FF unchanged', () => {
    const wide = 'an em dash — here';
    expect(oneByteText(wide)).toBe(wide);
  });

  it('stores ASCII held as two-byte one byte per character', () => {
    expect(haveSameMap(asciiHeldTwoByte, oneByteReference)).toBe(false);
    expect(haveSameMap(oneByteText(asciiHeldTwoByte), oneByteReference)).toBe(
      true
    );
  });

  it('makes escapeNonAscii output one byte per character', () => {
    const escaped = escapeNonAscii('an em dash — here, padded out');
    expect(escaped).toBe('an em dash \\u2014 here, padded out');
    expect(haveSameMap(escaped, oneByteReference)).toBe(true);
  });

  it('keeps a splice into MutableText one byte when the text allows it', () => {
    const text = new MutableText('start [slot] end of a one-byte bundle');
    text.splice(6, 12, asciiHeldTwoByte);
    const joined = text.toString();
    expect(joined).toBe(`start ${asciiHeldTwoByte} end of a one-byte bundle`);
    expect(haveSameMap(joined, oneByteReference)).toBe(true);
  });
});
