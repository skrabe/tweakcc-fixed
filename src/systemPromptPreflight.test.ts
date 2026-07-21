import { beforeAll, describe, expect, it } from 'vitest';

import { replayPromptPlans } from './systemPromptPreflight';
import { OffsetMapper, SpanClaim } from './systemPromptSites';
import {
  encodeReplacementForDelimiter,
  preloadStringsFile,
  pristineBodiesById,
} from './systemPromptSync';

const VERSION = '2.1.215';

describe('encodeReplacementForDelimiter', () => {
  it('doubles backslashes and escapes newlines/quotes at a double-quoted site', () => {
    const out = encodeReplacementForDelimiter('say \\"hi\\"\nbye', '"', false);
    expect(out.content).toBe('say \\\\\\"hi\\\\\\"\\nbye');
    expect(out.incomplete).toBe(false);
  });

  it('escapes the site delimiter only at a single-quoted site', () => {
    expect(encodeReplacementForDelimiter('it\'s "q"', "'", false).content).toBe(
      'it\\\'s "q"'
    );
  });

  it('leaves backslashes alone at a backtick site — escapeDepthZeroBackticks is parity-aware', () => {
    const out = encodeReplacementForDelimiter(
      'regex [\\s\\S] and \\`tick\\`',
      '`',
      false
    );
    expect(out.content).toBe('regex [\\s\\S] and \\`tick\\`');
    expect(out.autoEscaped).toBe(false);
  });

  it('auto-escapes an unescaped backtick and reports the repair', () => {
    const out = encodeReplacementForDelimiter('a `code` span', '`', false);
    expect(out.content).toBe('a \\`code\\` span');
    expect(out.autoEscaped).toBe(true);
  });

  it('reports an unclosed interpolation instead of emitting broken JS', () => {
    expect(
      encodeReplacementForDelimiter('tail ${OPEN', '`', false).incomplete
    ).toBe(true);
  });

  it('escapes non-ASCII last so a doubled backslash never eats the escape', () => {
    const out = encodeReplacementForDelimiter('em — dash', '"', true);
    expect(out.content).toBe('em \\u2014 dash');
    expect(out.content).not.toContain('\\\\u2014');
  });
});

describe('pristineBodiesById', () => {
  beforeAll(async () => {
    const result = await preloadStringsFile(VERSION);
    expect(result.success).toBe(true);
  }, 30_000);

  it('appends the BARE label between pieces — the ${ } already live in the pieces', async () => {
    const bodies = await pristineBodiesById(VERSION);
    const set = bodies.get(
      'agent-prompt-workflow-script-structured-return-note'
    );
    expect(set).toBeDefined();
    const body = [...set!][0];
    expect(body).toContain('${STRUCTURED_OUTPUT_TOOL_NAME}');
    // The trap: keying identifierMap by the piece index instead of
    // identifiers[i] silently yields UNKNOWN_n and makes prompts unmatchable.
    expect(body).not.toContain('UNKNOWN_');
    expect(body).not.toContain('$${');
  });

  it('keeps one entry per binary site — never dedups a multi-site id away', async () => {
    const bodies = await pristineBodiesById(VERSION);
    // 124 ids occupy several sites; same-shape sites collapse into one body,
    // but the id must still resolve.
    expect(
      bodies.get('system-prompt-project-memory-body-structure')
    ).toBeDefined();
    expect(bodies.size).toBeGreaterThan(2000);
  });
});

const claim = (
  id: string,
  site: number,
  start: number,
  end: number,
  replacement: string
): SpanClaim => ({
  id,
  site,
  start,
  end,
  replacement,
  surface: 'prompt',
  mutates: true,
  body: replacement,
});

describe('replayPromptPlans', () => {
  it('carries an ordinal forward and reports the final site as lost', async () => {
    const mapper = new OffsetMapper();
    mapper.record({ start: 0, end: 6 }, 5);
    const first = claim('first', 0, 0, 6, 'FIRST');
    const second = claim('second', 1, 7, 13, 'SECOND');
    const result = await replayPromptPlans(
      'FIRST TARGET',
      mapper,
      [
        {
          claim: first,
          regex: 'TARGET',
          spec: { regex: 'TARGET', pieces: ['TARGET'], version: VERSION },
          order: 0,
          getInterpolatedContent: () => first.replacement,
        },
        {
          claim: second,
          regex: 'TARGET',
          spec: { regex: 'TARGET', pieces: ['TARGET'], version: VERSION },
          order: 1,
          getInterpolatedContent: () => second.replacement,
        },
      ],
      false
    );

    expect(result.landed.get(first)).toBe(true);
    expect(result.landed.get(second)).toBe(false);
    expect(result.destinations.get(first)).toEqual({ start: 6, end: 11 });
    expect(result.content.slice(6, 11)).toBe('FIRST');
  });

  it('lets a relanded prompt clobber a later overlapping group', async () => {
    const mapper = new OffsetMapper();
    mapper.record({ start: 0, end: 7 }, 8);
    const first = claim('first', 0, 0, 3, 'XXX');
    const second = claim('second', 0, 0, 7, 'FINAL');
    const result = await replayPromptPlans(
      'AAA BBB!',
      mapper,
      [
        {
          claim: first,
          regex: 'AAA',
          spec: { regex: 'AAA', pieces: ['AAA'], version: VERSION },
          order: 0,
          getInterpolatedContent: () => first.replacement,
        },
        {
          claim: second,
          regex: 'AAA BBB',
          spec: {
            regex: 'AAA BBB',
            pieces: ['AAA BBB'],
            version: VERSION,
          },
          order: 1,
          getInterpolatedContent: () => second.replacement,
        },
      ],
      false
    );

    expect(result.content).toBe('XXX BBB!');
    expect(result.landed.get(first)).toBe(true);
    expect(result.landed.get(second)).toBe(false);
  });

  it('tracks a landed site created inside an earlier replacement', async () => {
    const mapper = new OffsetMapper();
    mapper.record({ start: 0, end: 3 }, 10);
    const authored = claim('authored', 0, 0, 3, 'AUTHORED');
    const result = await replayPromptPlans(
      'xxTARGETyy',
      mapper,
      [
        {
          claim: authored,
          regex: 'TARGET',
          spec: { regex: 'TARGET', pieces: ['TARGET'], version: VERSION },
          order: 0,
          getInterpolatedContent: () => authored.replacement,
        },
      ],
      false
    );

    const destination = result.destinations.get(authored)!;
    expect(destination).toEqual({ start: 2, end: 10 });
    expect(result.content.slice(destination.start, destination.end)).toBe(
      'AUTHORED'
    );
  });

  it('leaves a site unchanged when the apply guard skips it', async () => {
    const mapper = new OffsetMapper();
    const guarded = claim('guarded', 0, 0, 6, 'AUTHORED');
    const result = await replayPromptPlans(
      'TARGET',
      mapper,
      [
        {
          claim: guarded,
          regex: 'TARGET',
          spec: { regex: 'TARGET', pieces: ['TARGET'], version: VERSION },
          order: 0,
          getInterpolatedContent: () => guarded.replacement,
          shouldSkip: () => true,
        },
      ],
      false
    );

    expect(result.content).toBe('TARGET');
    expect(result.landed.get(guarded)).toBe(false);
    expect(result.mutations).toEqual([]);
  });
});
