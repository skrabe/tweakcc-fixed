// Locks the predicate-literal gate against skrabe/lobotomized-claude-code#24:
// an override that blanks a literal CC greps transcripts with, turning
// `.includes(needle)` unconditionally true. Regression targets are the real
// CC 2.1.226 minified shapes.

import { describe, it, expect } from 'vitest';
import {
  literalOf,
  bodyOf,
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
