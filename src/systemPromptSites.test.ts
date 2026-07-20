import { describe, it, expect } from 'vitest';
import {
  bodyCarriedBy,
  changedSpan,
  delimiterBefore,
  introducedRawNonAscii,
  lintBacktickEscapes,
  OffsetMapper,
  pickMatchForSplice,
  resolveCandidateSites,
  spanConflicts,
  SpanClaim,
} from './systemPromptSites';

const matchAt = (content: string, text: string, from = 0) => {
  const index = content.indexOf(text, from);
  const m = [text] as unknown as RegExpExecArray;
  m.index = index;
  return m;
};

const claim = (over: Partial<SpanClaim> & { start: number; end: number }) =>
  ({
    surface: 'prompt',
    id: 'x',
    site: 0,
    mutates: true,
    body: '',
    ...over,
  }) as SpanClaim;

describe('pickMatchForSplice', () => {
  it('returns null when nothing matched', () => {
    expect(pickMatchForSplice('abc', []).match).toBeNull();
  });

  it('disambiguates to the standalone string-literal value', () => {
    const content = 'x("hooks")+y=`prefix hooks suffix`';
    const matches = [
      matchAt(content, 'hooks', 0),
      matchAt(content, 'hooks', 12),
    ];
    const picked = pickMatchForSplice(content, matches);
    expect(picked.disambiguated).toBe(true);
    expect(picked.match?.index).toBe(content.indexOf('"hooks"') + 1);
  });

  it('keeps index 0 when ambiguous — sequential consumption of multi-site prompts', () => {
    // Two identical standalone sites: one catalogue entry splices each in turn,
    // so index 0 must stay the next unpatched site rather than becoming an error.
    const content = 'a="dup",b="dup"';
    const matches = [matchAt(content, 'dup', 0), matchAt(content, 'dup', 8)];
    const picked = pickMatchForSplice(content, matches);
    expect(picked.disambiguated).toBe(false);
    expect(picked.match).toBe(matches[0]);
  });
});

describe('resolveCandidateSites', () => {
  it('keeps every match when the count already equals the multiplicity', () => {
    const content = 'a="dup",b="dup"';
    const matches = [matchAt(content, 'dup', 0), matchAt(content, 'dup', 8)];
    expect(resolveCandidateSites(content, matches, 2)).toHaveLength(2);
  });

  it('narrows to the standalone sites when that hits the multiplicity', () => {
    const content = 'inline hooks here;x="hooks"';
    const matches = [
      matchAt(content, 'hooks', 0),
      matchAt(content, 'hooks', 12),
    ];
    const resolved = resolveCandidateSites(content, matches, 1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].index).toBe(content.indexOf('"hooks"') + 1);
  });
});

describe('lintBacktickEscapes', () => {
  it('flags a lone backslash escape that the template literal would cook', () => {
    const findings = lintBacktickEscapes('use [\\s\\S] to match');
    expect(findings.map(f => f.offending)).toEqual(['\\s', '\\S']);
    expect(findings[0].kind).toBe('lossy');
    expect(findings[0].required).toBe('\\\\s');
  });

  it('flags the jq-style `\\(` that silently loses its backslash', () => {
    const findings = lintBacktickEscapes('--jq \'"\\(.user.login)"\'');
    expect(findings).toHaveLength(1);
    expect(findings[0].offending).toBe('\\(');
    expect(findings[0].kind).toBe('lossy');
  });

  it('flags a backslash-newline line continuation', () => {
    const findings = lintBacktickEscapes('first \\\nsecond');
    expect(findings).toHaveLength(1);
    expect(findings[0].offending).toBe('\\<newline>');
  });

  it('classifies a redundant quote escape separately', () => {
    const findings = lintBacktickEscapes('say \\"hello\\"');
    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.kind === 'redundant')).toBe(true);
  });

  it('accepts the two escapes that protect source syntax', () => {
    expect(lintBacktickEscapes('a \\` b \\${NOT_A_SLOT} c')).toEqual([]);
  });

  it('accepts an even-parity run — the author already doubled it', () => {
    expect(lintBacktickEscapes('regex [\\\\s\\\\S] ok')).toEqual([]);
  });

  it('ignores backslashes inside a ${...} interpolation — that is JS, not prose', () => {
    expect(lintBacktickEscapes('${x.replace(/\\s+/g, " ")} tail')).toEqual([]);
  });

  it('does not treat an escaped \\${ as an interpolation opener', () => {
    // The `\n` after the escaped slot must still be reported: mistaking
    // `\${...}` for a real interpolation would swallow the rest of the line.
    const findings = lintBacktickEscapes('\\${CLAUDE_PLUGIN_ROOT} then \\n');
    expect(findings.map(f => f.offending)).toEqual(['\\n']);
  });

  it('reports the 1-based line and its text', () => {
    const findings = lintBacktickEscapes('line one\nline \\s two\nline three');
    expect(findings[0].line).toBe(2);
    expect(findings[0].lineText).toBe('line \\s two');
  });
});

describe('changedSpan / OffsetMapper', () => {
  it('returns null for identical content', () => {
    expect(changedSpan('abc', 'abc')).toBeNull();
  });

  it('locates the replaced span', () => {
    expect(changedSpan('aaXXbb', 'aaYYYbb')).toEqual({ start: 2, end: 4 });
  });

  it('survives a span longer than the comparison chunk', () => {
    const pad = 'p'.repeat(200_000);
    expect(changedSpan(pad + 'XX' + pad, pad + 'Y' + pad)).toEqual({
      start: 200_000,
      end: 200_002,
    });
  });

  it('maps working offsets back to pristine after earlier splices', () => {
    const mapper = new OffsetMapper();
    mapper.record({ start: 10, end: 20 }, 4); // 10 chars -> 4
    expect(mapper.toPristine(4)).toBe(4);
    expect(mapper.toPristine(14)).toBe(20);
    expect(mapper.spanToPristine({ start: 30, end: 40 })).toEqual({
      start: 36,
      end: 46,
    });
  });
});

describe('spanConflicts', () => {
  const never = () => false;

  it('reports the later claim when an earlier surface owns the bytes', () => {
    const owner = claim({
      start: 0,
      end: 100,
      surface: 'inline-blob',
      id: 'blob',
    });
    const loser = claim({ start: 10, end: 20, id: 'prompt-a', body: 'mine' });
    const conflicts = spanConflicts([owner, loser], never);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].claim.id).toBe('prompt-a');
    expect(conflicts[0].owner.id).toBe('blob');
  });

  it('ignores a loser whose content the owner already carries', () => {
    const owner = claim({
      start: 0,
      end: 100,
      surface: 'inline-blob',
      id: 'blob',
      body: 'intro\n  <when>text</when>\noutro',
    });
    const loser = claim({
      start: 10,
      end: 20,
      id: 'prompt-a',
      body: '<when>text</when>',
    });
    expect(spanConflicts([owner, loser], never)).toEqual([]);
  });

  it('ignores a pristine passthrough loser', () => {
    const owner = claim({ start: 0, end: 100, id: 'blob' });
    const loser = claim({
      start: 10,
      end: 20,
      id: 'p',
      mutates: false,
      body: 'x',
    });
    expect(spanConflicts([owner, loser], never)).toEqual([]);
  });

  it('honours an explicit shadows: declaration', () => {
    const owner = claim({ start: 0, end: 100, id: 'blob' });
    const loser = claim({ start: 10, end: 20, id: 'p', body: 'x' });
    const shadowedBy = (o: string, v: string) => o === 'blob' && v === 'p';
    expect(spanConflicts([owner, loser], shadowedBy)).toEqual([]);
  });

  it('does not report disjoint claims or the same id at several sites', () => {
    const a = claim({ start: 0, end: 10, id: 'p', site: 0, body: 'x' });
    const b = claim({ start: 20, end: 30, id: 'p', site: 1, body: 'x' });
    expect(spanConflicts([a, b], never)).toEqual([]);
  });
});

describe('bodyCarriedBy', () => {
  it('is true when every authored line survives in the owner', () => {
    expect(bodyCarriedBy('  one\n\ntwo ', 'x one y\nz two w')).toBe(true);
  });

  it('is false when the owner reworded a line', () => {
    expect(
      bodyCarriedBy('Each type below declares', 'Each type declares')
    ).toBe(false);
  });
});

describe('introducedRawNonAscii', () => {
  it('reports only codepoints the pristine text lacks', () => {
    expect(introducedRawNonAscii('a — b', 'a — b … c')).toEqual(['U+2026']);
  });

  it('is silent when everything is escaped', () => {
    expect(introducedRawNonAscii('a — b', 'a \\u2014 b')).toEqual([]);
  });
});

describe('delimiterBefore', () => {
  it('reads the character immediately before the match', () => {
    expect(delimiterBefore('x=`body`', 3)).toBe('`');
    expect(delimiterBefore('body', 0)).toBe('');
  });
});
