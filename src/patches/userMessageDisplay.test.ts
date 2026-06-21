import { describe, it, expect } from 'vitest';
import { escapeForTemplateLiteral } from './userMessageDisplay';

const BT = '`';

// userMessageDisplay splices config.format into a backtick template literal in
// cli.js. config.format can come from an untrusted --config-url, so it must be
// escaped: a backtick would terminate the literal (binary corruption) and a
// ${...} would inject an executable expression into Claude Code.
describe('escapeForTemplateLiteral', () => {
  it('is a no-op for a normal format (no regression for the common case)', () => {
    expect(escapeForTemplateLiteral(' > {} ')).toBe(' > {} ');
    expect(escapeForTemplateLiteral('[you]: {}')).toBe('[you]: {}');
  });

  it('escapes a backtick so it cannot terminate the template literal', () => {
    expect(escapeForTemplateLiteral('a' + BT + 'b')).toBe('a\\' + BT + 'b');
  });

  it('escapes ${...} so it cannot inject an executable expression', () => {
    expect(escapeForTemplateLiteral('${process.exit(1)}')).toBe(
      '\\${process.exit(1)}'
    );
  });

  it('escapes backslashes so an escape sequence cannot leak', () => {
    expect(escapeForTemplateLiteral('a\\b')).toBe('a\\\\b');
  });

  it('leaves the {} placeholder intact (it is replaced by the message after escaping)', () => {
    expect(escapeForTemplateLiteral('x{}y')).toBe('x{}y');
  });
});
