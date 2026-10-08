// Locks stable suffixes for id-collision families: a body keeps the id it had
// in the previous catalogue whatever order its sites appear in the bundle.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { disambiguateIdCollisions } = require('./promptExtractor.js');

const BASE = 'tool-result-fixture-collision-framing';
const BODIES = {
  head: [
    ['<fx-out>Running as @${', '(', ')}</fx-out>\n'],
    [0, 1],
  ],
  call: [
    ['<fx-out>${', '(', ')}</fx-out>'],
    [0, 1],
  ],
  plain: [['<fx-out>${', '}</fx-out>'], [0]],
  field: [
    ['<fx-out>${', '(', '.value)}</fx-out>'],
    [0, 1],
  ],
  fresh: [
    ['<fx-out>${', '(', '.extra)}</fx-out>'],
    [0, 1],
  ],
};
const site = (body, id = BASE) => ({
  id,
  pieces: [...BODIES[body][0]],
  identifiers: [...BODIES[body][1]],
  body,
});
const previous = (...pairs) => ({
  prompts: pairs.map(([body, id]) => site(body, id)),
});
const idsByBody = prompts => {
  const out = {};
  for (const p of prompts) (out[p.body] ||= new Set()).add(p.id);
  return Object.fromEntries(
    Object.entries(out).map(([b, ids]) => [b, [...ids].sort()])
  );
};
const PREV = previous(
  ['head', BASE],
  ['call', `${BASE}-2`],
  ['call', `${BASE}-2`],
  ['plain', `${BASE}-3`],
  ['plain', `${BASE}-3`],
  ['field', `${BASE}-4`]
);

describe('disambiguateIdCollisions', () => {
  it('keeps every body on its previous id when the sites reorder', () => {
    const orders = [
      ['plain', 'head', 'call', 'plain', 'field', 'call'],
      ['field', 'call', 'plain', 'call', 'head', 'plain'],
      ['call', 'plain', 'plain', 'field', 'call', 'head'],
    ];
    for (const order of orders) {
      const out = disambiguateIdCollisions(
        order.map(b => site(b)),
        PREV
      );
      expect(idsByBody(out)).toEqual({
        head: [BASE],
        call: [`${BASE}-2`],
        plain: [`${BASE}-3`],
        field: [`${BASE}-4`],
      });
    }
  });

  it('gives a new body the next suffix no previous body used', () => {
    const out = disambiguateIdCollisions(
      ['fresh', 'plain', 'head', 'call', 'field'].map(b => site(b)),
      PREV
    );
    expect(idsByBody(out)).toEqual({
      head: [BASE],
      call: [`${BASE}-2`],
      plain: [`${BASE}-3`],
      field: [`${BASE}-4`],
      fresh: [`${BASE}-5`],
    });
  });

  it('does not hand a removed body its id to a new body', () => {
    const out = disambiguateIdCollisions(
      ['fresh', 'field', 'head', 'plain'].map(b => site(b)),
      PREV
    );
    expect(idsByBody(out)).toEqual({
      head: [BASE],
      plain: [`${BASE}-3`],
      field: [`${BASE}-4`],
      fresh: [`${BASE}-5`],
    });
  });

  it('does not hand a removed head body the bare id', () => {
    const out = disambiguateIdCollisions(
      ['fresh', 'call', 'plain'].map(b => site(b)),
      PREV
    );
    expect(idsByBody(out)).toEqual({
      call: [`${BASE}-2`],
      plain: [`${BASE}-3`],
      fresh: [`${BASE}-5`],
    });
  });

  it('keeps the id of an edited body that shares its opening', () => {
    const lead =
      'This fixture session continues an earlier conversation whose summary ' +
      'follows below, and the opening is long enough to fingerprint. ';
    const edited = (body, tail, id = BASE) => ({
      id,
      pieces: [lead + tail],
      identifiers: [],
      body,
    });
    const prev = {
      prompts: [edited('old', 'Old tail.', BASE), site('plain', `${BASE}-2`)],
    };
    const out = disambiguateIdCollisions(
      [site('fresh'), site('plain'), edited('new', 'New tail, reworded.')],
      prev
    );
    expect(idsByBody(out)).toEqual({
      new: [BASE],
      plain: [`${BASE}-2`],
      fresh: [`${BASE}-3`],
    });
  });

  it('separates bodies whose text matches but whose slots differ', () => {
    const a = {
      id: BASE,
      pieces: ['<fx>${', '}${', '}</fx>'],
      identifiers: [0, 1],
      body: 'two',
    };
    const b = {
      id: BASE,
      pieces: ['<fx>${', '}${', '}</fx>'],
      identifiers: [0, 0],
      body: 'same',
    };
    const out = disambiguateIdCollisions([a, b], { prompts: [] });
    expect(out[0].id).not.toBe(out[1].id);
  });

  it('numbers an all-new family the same way in any order', () => {
    const run = order =>
      idsByBody(
        disambiguateIdCollisions(
          order.map(b => site(b)),
          { prompts: [] }
        )
      );
    const a = run(['plain', 'call', 'head', 'plain']);
    const b = run(['head', 'call', 'plain', 'plain']);
    expect(a).toEqual(b);
    expect(a.head).toEqual([BASE]);
    expect(new Set(Object.values(a).flat()).size).toBe(3);
  });

  // The 2.1.292 `<local-command-stdout>` family: the bare id named the
  // background-running wrapper and -3 the plain one.
  describe('a family with one body left on the id', () => {
    const FAM = 'tool-result-fixture-stdout-framing';
    const WRAP = {
      background: [
        [
          '<fx-stdout>Running in the background as @${',
          '(',
          '(',
          '.name))}</fx-stdout>\n',
        ],
        [0, 1, 2],
      ],
      call: [
        ['<fx-stdout>${', '(', ')}</fx-stdout>'],
        [0, 1],
      ],
      plain: [['<fx-stdout>${', '}</fx-stdout>'], [0]],
      nested: [
        ['<fx-stdout>${', '(', '(', '))}</fx-stdout>'],
        [0, 1, 2],
      ],
      display: [
        ['<fx-stdout>${', '(', '.displayText)}</fx-stdout>'],
        [0, 1],
      ],
      value: [
        ['<fx-stdout>${', '(', '.value)}</fx-stdout>'],
        [0, 1],
      ],
      fresh: [['<fx-stdout>${', '.text}</fx-stdout>'], [0]],
    };
    const at = (body, id = FAM) => ({
      id,
      pieces: [...WRAP[body][0]],
      identifiers: [...WRAP[body][1]],
      body,
    });
    const PREV292 = {
      prompts: [
        at('background', FAM),
        at('call', `${FAM}-2`),
        at('plain', `${FAM}-3`),
        at('plain', `${FAM}-3`),
        at('nested', `${FAM}-4`),
        at('display', `${FAM}-5`),
        at('value', `${FAM}-6`),
      ],
    };

    it('gives a surviving body back its previous suffix', () => {
      const out = disambiguateIdCollisions([at('plain'), at('plain')], PREV292);
      expect(idsByBody(out)).toEqual({ plain: [`${FAM}-3`] });
    });

    it('does not move a removed body its id to a new body', () => {
      const out = disambiguateIdCollisions([at('fresh')], PREV292);
      expect(idsByBody(out)).toEqual({ fresh: [`${FAM}-7`] });
    });

    it('leaves the body that owned the bare id on it', () => {
      const out = disambiguateIdCollisions([at('background')], PREV292);
      expect(idsByBody(out)).toEqual({ background: [FAM] });
    });

    it('leaves an edited prompt with no suffixed siblings on its id', () => {
      const out = disambiguateIdCollisions([at('fresh')], {
        prompts: [at('plain')],
      });
      expect(idsByBody(out)).toEqual({ fresh: [FAM] });
    });
  });

  it('keeps bodies apart that differ only by a backslash', () => {
    const id = 'tool-result-fixture-unc-path';
    const one = {
      id,
      pieces: ['Mount \\server\\share at ${', '} first.'],
      identifiers: [0],
      body: 'one',
    };
    const two = {
      id,
      pieces: ['Mount \\\\server\\share at ${', '} first.'],
      identifiers: [0],
      body: 'two',
    };
    const prev = {
      prompts: [
        { ...one, id },
        { ...two, id: `${id}-2` },
      ],
    };
    for (const order of [
      [one, two],
      [two, one],
    ]) {
      const out = disambiguateIdCollisions(
        order.map(p => ({ ...p })),
        prev
      );
      expect(idsByBody(out)).toEqual({ one: [id], two: [`${id}-2`] });
    }
    const fresh = disambiguateIdCollisions([{ ...one }, { ...two }], {
      prompts: [],
    });
    expect(fresh[0].id).not.toBe(fresh[1].id);
  });

  it('leaves a same-body multi-site id alone', () => {
    const out = disambiguateIdCollisions(
      [site('plain'), site('plain'), site('plain')],
      { prompts: [] }
    );
    expect(out.map(p => p.id)).toEqual([BASE, BASE, BASE]);
  });
});
