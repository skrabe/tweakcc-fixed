// Locks the predicate-literal gate against skrabe/lobotomized-claude-code#24:
// an override that blanks a literal CC greps transcripts with, turning
// `.includes(needle)` unconditionally true. Regression targets are the real
// CC 2.1.226 minified shapes.

import { describe, it, expect } from 'vitest';
import {
  literalOf,
  bodyOf,
  createEvidenceMatcher,
  matchEvidence,
  sentenceSurvives,
} from './checkScannedLiterals.mjs';

// The `/loop` classifier, verbatim from the 2.1.226 bundle.
const LOOP_SITE =
  'let s;try{s=Zt(o)}catch{if(i)return o.includes("<command-name>/loop</command-name>");continue}' +
  'return c.some((u)=>u.includes("<command-name>/loop</command-name>"))';

// The session-descriptor prefilter cluster: a const assigned once, then used as
// a needle over raw transcript lines.
const DESCRIPTOR_SITE =
  'var XPr,oti,ezb=52428800,tzb=200,jUp=60,rzb,nzb,zUp=\'"content":"<command-name>/\',' +
  'ozb=\'"content":"<command-message>\',lzb=\'"role":"user"\';' +
  'for(let u of l.split("\\n")){if(u.length<10)continue;if(u.includes(zUp)||u.includes(ozb))continue}';

describe('checkScannedLiterals: needle detection', () => {
  it('flags a literal passed inline to .includes()', () => {
    expect(
      matchEvidence(LOOP_SITE, '<command-name>/loop</command-name>')
    ).toEqual(['inline .includes()']);
  });

  it('follows a single-assignment const to its matcher', () => {
    expect(
      matchEvidence(DESCRIPTOR_SITE, '"content":"<command-name>/')
    ).toEqual(['zUp -> .includes()']);
  });

  it('ignores a literal that is only emitted', () => {
    const emitted =
      'var q="Respond in flowing prose.";function f(){return `${q}\\n`}';
    expect(matchEvidence(emitted, 'Respond in flowing prose.')).toEqual([]);
  });

  it('does not mistake a reused local temp for the const holding the literal', () => {
    // `o` precedes an `=` before the literal but is assigned all over the
    // bundle; treating it as the owning const reported a bogus finding on
    // data-import-unmappable-unexpected-table-shape.
    const noisy =
      'let o="Has an unexpected shape.";for(let[o,i]of m)if(!n.includes(o)){}o=1;o=2;';
    expect(matchEvidence(noisy, 'Has an unexpected shape.')).toEqual([]);
  });

  it('reads a literal stored with an escaped quote', () => {
    const src =
      'var Cz="The user doesn\'t want to take this action right now.";' +
      'if(c.startsWith(Cz)){}';
    expect(
      matchEvidence(src, "The user doesn't want to take this action right now.")
    ).toEqual(['Cz -> .startsWith()']);
  });
});

// The pre-index implementation, verbatim: up to ~20 full-bundle scans per
// literal. The indexed matcher must agree with it on every input.
const MATCHERS = [
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'split',
  'search',
];
const quoted = (lit, q) =>
  q +
  lit
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(q, 'g'), '\\' + q)
    .replace(/\n/g, '\\n') +
  q;
const assignedOnce = (src, name) => {
  let count = 0;
  for (
    let i = src.indexOf(name + '=');
    i !== -1;
    i = src.indexOf(name + '=', i + 1)
  ) {
    const before = src[i - 1];
    const after = src[i + name.length + 1];
    if (before && /[\w$]/.test(before)) continue;
    if (after === '=') continue;
    if (++count > 1) return false;
  }
  return count === 1;
};
const naiveMatchEvidence = (src, lit) => {
  const found = [];
  for (const q of ['"', "'"]) {
    const needle = quoted(lit, q);
    if (!src.includes(needle)) continue;
    for (const fn of MATCHERS) {
      if (src.includes(`.${fn}(${needle})`)) found.push(`inline .${fn}()`);
    }
    const names = new Set();
    let i = src.indexOf(needle);
    for (let n = 0; i !== -1 && n < 20; n++, i = src.indexOf(needle, i + 1)) {
      const pre = src.slice(Math.max(0, i - 40), i).trimEnd();
      if (!pre.endsWith('=')) continue;
      const m = pre
        .slice(0, -1)
        .trimEnd()
        .match(/[$\w]+$/);
      if (m && m[0].length <= 12) names.add(m[0]);
    }
    for (const name of names) {
      if (!assignedOnce(src, name)) continue;
      for (const fn of MATCHERS) {
        if (
          src.includes(`.${fn}(${name})`) ||
          src.includes(`.${fn}(${name},`)
        ) {
          found.push(`${name} -> .${fn}()`);
        }
      }
    }
  }
  return [...new Set(found)];
};

describe('checkScannedLiterals: indexed matcher agrees with the scan', () => {
  // Shapes that stress the index: needles shorter and longer than its prefix
  // bucket, buckets shared by several needles, overlapping occurrences, a
  // needle at offset 0, escaped quotes, backslashes and newlines, more than 20
  // occurrences, `==` comparisons, consts assigned once and twice, and the
  // `.fn(name,` second-argument form.
  const LITERALS = [
    'a',
    'ab',
    'abcde',
    'abcdef',
    '<bash-input>',
    '<bash-input> and more',
    '<bash-output>',
    "don't",
    'say "hi"',
    'C:\\path\\x',
    'line one\nline two',
    'x',
    'shared prefix one',
    'shared prefix two',
    'never present',
    'twenty',
  ];
  const SRC = [
    '"a".includes(q);',
    'if(s.startsWith("a")){}',
    'var Ab=\'ab\',Cd="abcde";u.endsWith(Ab);w.indexOf(Cd,1);',
    'Cd=2;',
    'let Ef="abcdef";t.split(Ef);',
    'z.includes("<bash-input>");z.includes("<bash-input> and more");',
    'var Bo="<bash-output>";l.lastIndexOf(Bo);',
    "var Dn='don\\'t';m.search(Dn);",
    'var Sh="say \\"hi\\"";if(Sh==="x"){}g.includes(Sh);',
    'var P="C:\\\\path\\\\x";h.includes(P);',
    'var L="line one\\nline two";k.startsWith(L);',
    '"x"x"x".endsWith("x")',
    'var S1="shared prefix one",S2="shared prefix two";a.includes(S2);',
    Array.from({ length: 25 }, (_, i) => `v${i}="twenty";`).join(''),
    'var Tw="twenty";n.includes(Tw);',
  ].join('\n');

  it('returns the same evidence for every literal', () => {
    const indexed = createEvidenceMatcher(SRC, LITERALS);
    for (const lit of LITERALS) {
      expect([lit, indexed(lit)]).toEqual([lit, naiveMatchEvidence(SRC, lit)]);
    }
  });

  it('finds evidence the scan finds, so the comparison is not vacuous', () => {
    const indexed = createEvidenceMatcher(SRC, LITERALS);
    const hits = LITERALS.filter(lit => indexed(lit).length > 0);
    expect(hits.length).toBeGreaterThanOrEqual(8);
    expect(indexed('never present')).toEqual([]);
  });

  it('agrees on randomized bundles', () => {
    let seed = 7;
    const rand = n => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const ATOMS = [
      '"',
      "'",
      '\\',
      'ab',
      'a',
      '=',
      '==',
      ';',
      ',',
      ')',
      '(',
      '.includes(',
      '.startsWith(',
      '.split(',
      'Q',
      'Qz',
      ' ',
      '\\n',
      'xyzxyzxy',
    ];
    const lits = [
      'a',
      'ab',
      'Q',
      'xyzxyzxy',
      'xyzxyzxyab',
      "a'b",
      'a"b',
      'a\\b',
    ];
    for (let round = 0; round < 300; round++) {
      let src = '';
      const len = 20 + rand(120);
      for (let k = 0; k < len; k++) src += ATOMS[rand(ATOMS.length)];
      const indexed = createEvidenceMatcher(src, lits);
      for (const lit of lits) {
        expect([src, lit, indexed(lit)]).toEqual([
          src,
          lit,
          naiveMatchEvidence(src, lit),
        ]);
      }
    }
  });
});

describe('checkScannedLiterals: prompt reconstruction', () => {
  it('reconstructs a slot-free prompt to its literal', () => {
    expect(literalOf({ pieces: ['<command-name>/loop</command-name>'] })).toBe(
      '<command-name>/loop</command-name>'
    );
  });

  it('skips a prompt carrying a runtime slot, which is never a needle', () => {
    expect(
      literalOf({ pieces: ['<local-command-stdout>', {}, '</a>'] })
    ).toBeNull();
  });

  it('treats a whitespace-only prompt as absent', () => {
    expect(literalOf({ pieces: ['  \n'] })).toBeNull();
  });

  it('strips frontmatter, leaving a wiped override empty', () => {
    const wiped = '<!--\nname: X\nccVersion: 2.1.226\n-->\n\n';
    expect(bodyOf(wiped)).toBe('');
    expect(bodyOf(`${wiped}<command-name>/loop</command-name>\n`)).toBe(
      '<command-name>/loop</command-name>'
    );
  });
});

// CC 2.1.267 rewrites the Artifact `writes` parameter for the action surface
// with [["separate write_db calls","separate calls"]]. Deleting the whole
// sentence leaves nothing to restate; rewording it keeps text the rewrite now
// misses.
describe('sentenceSurvives (rewrite-table needles)', () => {
  const pristine =
    'Each document is addressed at most once. Prefer it over separate write_db calls whenever you write more than a couple of documents.';
  const needle = 'separate write_db calls';
  it('treats a whole-sentence delete as nothing left to restate', () => {
    expect(
      sentenceSurvives(
        pristine,
        needle,
        'Each document is addressed at most once.'
      )
    ).toBe(false);
  });
  it('flags a reworded sentence that dropped only the needle', () => {
    expect(
      sentenceSurvives(
        pristine,
        needle,
        'Each document is addressed at most once. Prefer it over individual writes whenever you write more than a couple of documents.'
      )
    ).toBe(true);
  });
});
