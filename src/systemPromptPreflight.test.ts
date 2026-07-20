import { describe, it, expect, beforeAll } from 'vitest';
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
