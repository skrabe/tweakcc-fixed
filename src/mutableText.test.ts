import { describe, expect, it } from 'vitest';

import { MutableText } from './mutableText';

describe('MutableText', () => {
  it('matches sequential string splices, slices, and character reads', () => {
    const text = new MutableText('alpha beta gamma');
    text.splice(6, 10, 'B');
    text.splice(0, 5, 'A');
    text.splice(text.length, text.length, '!');
    expect(text.toString()).toBe('A B gamma!');
    expect(text.slice(2, 9)).toBe('B gamma');
    expect(text.charAt(0)).toBe('A');
    expect(text.charAt(text.length - 1)).toBe('!');
  });

  it('handles a splice crossing several existing chunks', () => {
    const text = new MutableText('0123456789');
    text.splice(2, 4, 'AB');
    text.splice(6, 8, 'CD');
    text.splice(1, 9, 'x');
    expect(text.toString()).toBe('0x9');
  });
});
