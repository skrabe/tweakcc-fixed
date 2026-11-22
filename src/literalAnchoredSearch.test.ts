import { describe, expect, it } from 'vitest';

import {
  literalAnchorable,
  literalAnchored,
  literalAnchoredStats,
} from './literalAnchoredSearch';
import {
  PUSH_TOP_PATTERN_FORMATTED,
  PUSH_TOP_PATTERN_MINIFIED,
} from './patches/tableFormat';
import {
  THEME_NAME_MAP_PATTERN,
  THEME_VAR_ASSIGN_PATTERN,
} from './patches/themes';
import {
  PICKER_EFFORT_DISPLAY,
  PICKER_EFFORT_UNSUPPORTEDS,
} from './patches/fablePlan';

const PATTERNS: RegExp[] = [
  PUSH_TOP_PATTERN_MINIFIED,
  PUSH_TOP_PATTERN_FORMATTED,
  THEME_VAR_ASSIGN_PATTERN,
  THEME_NAME_MAP_PATTERN,
  PICKER_EFFORT_DISPLAY,
  ...PICKER_EFFORT_UNSUPPORTEDS,
];

const longId = 'a'.repeat(5000);

const FIXTURE = [
  `x;${longId}.push(T("top"));R.push(T("top")),R.push(...);`,
  `R.push(T("top")),R.push(T("top")),Q.push(T("top")),`,
  `${longId}.push(\n   T(  "top" ) ) ;\n  S.push(\n T( "top" ) ) ,\n  next`,
  `foo.push(T("top"));bar.push(T("top")),`,
  `$a=$b.push(T("top")),"top")),`,
  `hM3={label:"Dark mode",value:"dark"},${longId}={label:"Light",value:light},Zq={label:"Light mode",value:"light"}`,
  `${longId}={label:"Monochrome",value:"mono"}`,
  `return{dark:"Dark mode","light":"Light mode"};${longId}={dark:"Dark mode",light:Light};`,
  `${longId}!==void 0&&!x&&y(z,{marginBottom:1,flexDirection:"column",children:k;`,
  `Ab!==void 0&&!x&&y(z,{marginBottom:1,flexDirection:"column",children:k?w:v`,
  `${longId}(r,{dimColor:!0,children:[e(_1,{effort:void 0})," ",\`Effort supported\`]})`,
  `o(r,{dimColor:!0,children:[e(_1,{effort:void 0})," ",\`Effort not supported\`]})`,
].join('\n');

const spans = (ms: Iterable<RegExpMatchArray | null>) =>
  [...ms].map(m =>
    m ? { index: m.index, captures: [...m], input: m.input?.length } : m
  );

const nativeResult = (text: string, regex: RegExp) => {
  regex.lastIndex = 0;
  if (regex.global) {
    const found = spans(text.matchAll(regex));
    const out = text.replace(regex, '');
    return { found, out, lastIndex: regex.lastIndex };
  }
  const found = spans([text.match(regex)]);
  const out = text.replace(regex, '');
  return { found, out, lastIndex: regex.lastIndex };
};

const anchoredResult = (text: string, regex: RegExp) => {
  regex.lastIndex = 0;
  if (regex.global) {
    const found = spans(literalAnchored.matchAll(text, regex));
    const out = literalAnchored.replace(text, regex, '');
    return { found, out, lastIndex: regex.lastIndex };
  }
  const found = spans([literalAnchored.match(text, regex)]);
  const out = literalAnchored.replace(text, regex, '');
  return { found, out, lastIndex: regex.lastIndex };
};

describe('literalAnchored', () => {
  it('routes every patch pattern through a literal anchor', () => {
    for (const regex of PATTERNS) expect(literalAnchorable(regex)).toBe(true);
  });

  it('matches the native search on the combined adversarial fixture', () => {
    const before = literalAnchoredStats.budgetFallbacks;
    for (const regex of PATTERNS) {
      const native = nativeResult(FIXTURE, regex);
      const anchored = anchoredResult(FIXTURE, regex);
      expect(anchored).toEqual(native);
      expect(anchored.out !== FIXTURE).toBe(native.out !== FIXTURE);
    }
    expect(
      nativeResult(FIXTURE, PUSH_TOP_PATTERN_MINIFIED).found.length
    ).toBeGreaterThan(4);
    expect(literalAnchoredStats.budgetFallbacks).toBeGreaterThan(before);
  }, 60000);

  it('finds every global match when matches are adjacent', () => {
    const text = 'R.push(T("top")),'.repeat(50);
    expect(literalAnchored.replace(text, PUSH_TOP_PATTERN_MINIFIED, '')).toBe(
      ''
    );
    expect([
      ...literalAnchored.matchAll(text, PUSH_TOP_PATTERN_FORMATTED),
    ]).toHaveLength(50);
  });

  it('leaves sticky and other flags on the native search', () => {
    for (const regex of PATTERNS) {
      for (const flags of ['y', 'gy', 'gi', 'gm', 'gu', 'gd']) {
        const copy = new RegExp(regex.source, flags);
        expect(literalAnchorable(copy)).toBe(false);
      }
    }
    const sticky = /aX/y;
    expect(literalAnchored.match('!aX', sticky)).toBeNull();
    expect(sticky.lastIndex).toBe(0);
    const stickyGlobal = /aX/gy;
    expect(literalAnchored.replace('!aX', stickyGlobal, '')).toBe('!aX');
  });

  it('leaves replacement patterns with $ on the native search', () => {
    const text = 'x;R.push(T("top")),y';
    expect(
      literalAnchored.replace(text, PUSH_TOP_PATTERN_MINIFIED, '<$1|$2|$&>')
    ).toBe(text.replace(PUSH_TOP_PATTERN_MINIFIED, '<$1|$2|$&>'));
  });

  it('keeps matchAll starting from a nonzero lastIndex', () => {
    const regex = new RegExp(PUSH_TOP_PATTERN_MINIFIED.source, 'g');
    const text = 'A.push(T("top")),B.push(T("top")),';
    regex.lastIndex = 5;
    const anchored = spans(literalAnchored.matchAll(text, regex));
    expect(regex.lastIndex).toBe(5);
    expect(anchored).toEqual(spans(text.matchAll(regex)));
    expect(anchored).toHaveLength(1);
  });

  it('rejects patterns without a usable literal anchor', () => {
    expect(literalAnchorable(/[a-z]+abc/g)).toBe(false);
    expect(literalAnchorable(/[x-z]+abab/g)).toBe(false);
    expect(literalAnchorable(/a|b/g)).toBe(false);
    expect(literalAnchorable(/.+;/g)).toBe(false);
    expect(literalAnchorable(/[^;]+;/g)).toBe(false);
    expect(literalAnchorable(/(?<=x)[a-z]+;/g)).toBe(false);
    expect(literalAnchorable(/\w+;/g)).toBe(true);
  });

  it('matches the native search on seeded random text', () => {
    const tokens = [
      'a',
      'Zq',
      '$',
      '.',
      'push',
      '(',
      ')',
      '"top"',
      'T',
      ',',
      ';',
      ' ',
      '\n',
      '={label:"',
      'Dark',
      'Light mode',
      '",value:"',
      'dark',
      '"}',
      'return',
      '{',
      '}',
      ':"',
      'Monochrome',
      '!==void 0&&!',
      '&&',
      ',{marginBottom:1,flexDirection:"column",children:',
      '?',
      ',{dimColor:!0,children:[',
      ',{effort:void 0})," ",`Effort not supported',
      'r',
      'R.push(T("top")),',
    ];
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let round = 0; round < 300; round++) {
      let text = '';
      const n = 20 + Math.floor(next() * 200);
      for (let i = 0; i < n; i++) {
        text += tokens[Math.floor(next() * tokens.length)];
      }
      for (const regex of PATTERNS) {
        expect(anchoredResult(text, regex)).toEqual(nativeResult(text, regex));
      }
    }
  });
});
