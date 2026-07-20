import { describe, expect, it } from 'vitest';
import {
  buildProjection,
  evaluateCanaries,
  isMainTurn,
  renderProjection,
} from './projection.mjs';
import { DEFAULT_ROW_ID, SELECTOR_ROWS, findRow } from './selectors.mjs';

const defaultRow = findRow(DEFAULT_ROW_ID);

// Verbatim from a real 2.1.215 capture (lean gate). The escapes here are the
// point of the whole test: the runtime text contains a single backslash before
// `s`, `w` and the braces.
const GREP_DESCRIPTION =
  'Content search built on ripgrep. Prefer this over `grep`/`rg` via Bash.\n' +
  '- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Ripgrep, not ' +
  'grep — escape literal braces (`interface\\{\\}`).\n' +
  '- `multiline: true` for patterns that span lines.\n\n' +
  'Search backend note (fff): prefer one bare identifier over regex; results ' +
  'are relevance-ranked, so read the top hit first.';

const goodBody = () =>
  JSON.stringify({
    model: 'claude-opus-4-8',
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Use ${d.key} in workflow examples.' },
    ],
    tools: [
      { name: 'Grep', description: GREP_DESCRIPTION },
      { name: 'Bash', description: 'Run a command.' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'MARKER-1' }] }],
  });

const canaryById = (row, projection) =>
  Object.fromEntries(evaluateCanaries(row, projection).map(r => [r.id, r]));

describe('buildProjection', () => {
  it('narrows to system text, tool names and descriptions', () => {
    const projection = buildProjection(goodBody());
    expect(projection.model).toBe('claude-opus-4-8');
    expect(projection.system).toEqual([
      'You are Claude Code.',
      'Use ${d.key} in workflow examples.',
    ]);
    expect(projection.tools.map(t => t.name)).toEqual(['Grep', 'Bash']);
  });

  it('accepts a plain string system prompt', () => {
    const projection = buildProjection(
      JSON.stringify({ system: 'flat prompt', tools: [] })
    );
    expect(projection.system).toEqual(['flat prompt']);
  });

  it('tolerates a request with no tools', () => {
    const projection = buildProjection(JSON.stringify({ system: [] }));
    expect(projection.tools).toEqual([]);
  });
});

describe('isMainTurn', () => {
  it('accepts a tool-bearing turn containing the marker', () => {
    expect(isMainTurn(goodBody(), 'MARKER-1')).toBe(true);
  });

  it('rejects the Haiku title side-call that has the marker but no tools', () => {
    const sideCall = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      system: [{ type: 'text', text: 'Generate a concise title' }],
      tools: [],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '<session>MARKER-1' }],
        },
      ],
    });
    expect(isMainTurn(sideCall, 'MARKER-1')).toBe(false);
  });

  it('rejects a turn for a different marker', () => {
    expect(isMainTurn(goodBody(), 'MARKER-2')).toBe(false);
  });

  it('rejects a non-JSON body without throwing', () => {
    expect(isMainTurn('not json', 'MARKER-1')).toBe(false);
  });
});

describe('default row canaries', () => {
  it('passes against a faithful capture', () => {
    const results = evaluateCanaries(defaultRow, buildProjection(goodBody()));
    expect(results.filter(r => !r.pass)).toEqual([]);
  });

  it('fails when backslashes are eaten at a backtick splice site', () => {
    const raw = JSON.parse(goodBody());
    raw.tools[0].description = GREP_DESCRIPTION.replace(
      'function\\s+\\w+',
      'functions+w+'
    );
    const results = canaryById(defaultRow, buildProjection(raw));
    expect(results['grep-regex-backslashes-survive'].pass).toBe(false);
    expect(results['grep-regex-backslashes-not-eaten'].pass).toBe(false);
  });

  it('fails when ripgrep brace escaping is lost', () => {
    const raw = JSON.parse(goodBody());
    raw.tools[0].description = GREP_DESCRIPTION.replace(
      'interface\\{\\}',
      'interface{}'
    );
    const results = canaryById(defaultRow, buildProjection(raw));
    expect(results['grep-braces-escaped'].pass).toBe(false);
    expect(results['grep-braces-not-raw'].pass).toBe(false);
  });

  it('fails loudly when the Grep tool never reaches the wire', () => {
    const raw = JSON.parse(goodBody());
    raw.tools = raw.tools.filter(t => t.name !== 'Grep');
    const results = canaryById(defaultRow, buildProjection(raw));
    expect(results['grep-braces-escaped'].pass).toBe(false);
    expect(results['grep-braces-escaped'].detail).toContain('absent');
  });

  it('fails when the fff override never reached the model', () => {
    const raw = JSON.parse(goodBody());
    raw.tools[0].description = GREP_DESCRIPTION.replace(
      'Search backend note (fff)',
      'Search backend note'
    );
    const results = canaryById(defaultRow, buildProjection(raw));
    expect(results['grep-fff-backend-note'].pass).toBe(false);
  });

  it('catches an unresolved ALLCAPS placeholder anywhere in the projection', () => {
    const raw = JSON.parse(goodBody());
    raw.system.push({
      type: 'text',
      text: 'Cancel after ${CANCEL_DAYS} days.',
    });
    const results = canaryById(defaultRow, buildProjection(raw));
    expect(results['no-allcaps-placeholder-leak'].pass).toBe(false);
    expect(results['no-allcaps-placeholder-leak'].detail).toContain(
      'CANCEL_DAYS'
    );
  });

  it('does not mistake a lowercase JS example for a placeholder leak', () => {
    const results = canaryById(defaultRow, buildProjection(goodBody()));
    expect(results['no-allcaps-placeholder-leak'].pass).toBe(true);
  });

  it('catches the patcher leak-guard notice reaching the model', () => {
    const raw = JSON.parse(goodBody());
    raw.system.push({ type: 'text', text: 'Unresolved placeholder: FOO' });
    const results = canaryById(defaultRow, buildProjection(raw));
    expect(results['no-unresolved-placeholder-notice'].pass).toBe(false);
  });
});

describe('selector matrix', () => {
  it('ships exactly one enabled row', () => {
    expect(SELECTOR_ROWS.filter(r => r.enabled).map(r => r.id)).toEqual([
      DEFAULT_ROW_ID,
    ]);
  });

  it('gives every row a unique id and at least one canary', () => {
    const ids = SELECTOR_ROWS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of SELECTOR_ROWS) {
      expect(row.canaries.length).toBeGreaterThan(0);
    }
  });

  it('gives every canary a unique id and a failure meaning within its row', () => {
    for (const row of SELECTOR_ROWS) {
      const ids = row.canaries.map(c => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const canary of row.canaries) {
        expect(canary.why).toBeTruthy();
        expect(
          canary.mustContain ?? canary.mustNotContain ?? canary.mustNotMatch
        ).toBeTruthy();
      }
    }
  });

  it('marks unshipped rows unverified so they are not mistaken for coverage', () => {
    for (const row of SELECTOR_ROWS) {
      if (!row.enabled) expect(row.verified).toBe(false);
    }
  });
});

describe('renderProjection', () => {
  it('writes a human-readable artifact carrying the tool descriptions', () => {
    const text = renderProjection(defaultRow, buildProjection(goodBody()));
    expect(text).toContain('# liveness projection — row default-print-lean');
    expect(text).toContain('### Grep');
    expect(text).toContain('interface\\{\\}');
  });
});
