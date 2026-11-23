// Locks the trim-slot gate against the miss it was built for: a trim that
// deletes the last occurrence of a runtime interpolation, which applies clean,
// parses, smokes green, and leaves the model with no value where one belongs.
// Regression targets are the real CC 2.1.226 shapes.

import { describe, it, expect } from 'vitest';
import {
  normalizeToken,
  tokensOf,
  reconstruct,
  stripFrontmatter,
  lostTokens,
  scopedTokensOf,
} from './checkTrimSlots.mjs';

describe('checkTrimSlots: token identity', () => {
  it('takes the opening identifier of a nested interpolation', () => {
    // the naive match truncates at the first inner `}`, so the raw token text
    // is not a stable key — this is the system-prompt-worker-agent shape
    expect(normalizeToken('${AGENT_TOOL_NAME()>1?`- If you have ${OTHER}')).toBe(
      'AGENT_TOOL_NAME'
    );
  });

  it('keeps a property path, because the slot binds through it', () => {
    expect(normalizeToken('${ATTACHMENT_OBJECT.remaining}')).toBe('ATTACHMENT_OBJECT.remaining');
  });

  it('reads the {{TEMPLATE}} form CC fills from the model catalogue', () => {
    expect(normalizeToken('{{OPUS_ID}}')).toBe('OPUS_ID');
  });

  it('drops the degenerate forms reconstruction can emit', () => {
    // `${}` and `${""}` name nothing; counting them is pure noise
    expect(normalizeToken('${}')).toBeNull();
    expect(normalizeToken('${""}')).toBeNull();
  });
});

describe('checkTrimSlots: lost tokens', () => {
  const pristine =
    '${DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_0.length} browsers are connected. ' +
    '${DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_1(DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_2.askUserToolName)}';

  it('flags the 2.1.226 browser-disambiguation cut', () => {
    const trimmed = '${DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_0.length} browsers are connected.';
    expect(lostTokens([pristine], trimmed)).toEqual([
      'DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_1',
    ]);
  });

  it('says nothing when every token still has a home', () => {
    expect(lostTokens([pristine], pristine)).toEqual([]);
  });

  it('does not flag a token that survives elsewhere in the body', () => {
    // deleting one code example that happens to carry {{OPUS_ID}} is fine as
    // long as another occurrence remains — that distinction is the whole
    // reason the rule is "zero remaining", not "the sets must match"
    const p = 'call with {{OPUS_ID}}\n\n```py\nmodel="{{OPUS_ID}}"\n```';
    expect(lostTokens([p], 'call with {{OPUS_ID}}')).toEqual([]);
  });

  it('unions the slots of every site of a same-id multi-site prompt', () => {
    // a first-entry-only comparison is how stubs have been misclassified before
    const a = 'one ${ALPHA}';
    const b = 'two ${BETA}';
    expect(lostTokens([a, b], 'one ${ALPHA}').sort()).toEqual(['BETA']);
  });

  it('reports a suppression as losing every token it carried', () => {
    expect(lostTokens([pristine], '')).toHaveLength(2);
  });
});

describe('checkTrimSlots: body handling', () => {
  it('reconstructs with the bare label and the identifiers[i] key', () => {
    const p = {
      pieces: ['a ${', '} b'],
      identifiers: [3],
      identifierMap: { 3: 'NAME' },
    };
    // the `${` and `}` are already in the pieces; appending `${NAME}` here
    // would double them, and keying on i instead of identifiers[i] binds the
    // wrong slot
    expect(reconstruct(p)).toBe('a ${NAME} b');
  });

  it('strips the override front-matter comment', () => {
    expect(stripFrontmatter('<!--\nname: x\n-->\nbody ${A}')).toBe('body ${A}');
  });

  it('leaves a body that has no front-matter alone', () => {
    expect(stripFrontmatter('body ${A}')).toBe('body ${A}');
  });

  it('finds tokens through the front-matter strip', () => {
    expect([...tokensOf(stripFrontmatter('<!--\nx: 1\n-->\nhi ${A} and {{B}}'))].sort()).toEqual([
      'A',
      'B',
    ]);
  });
});


describe('checkTrimSlots: token scope', () => {
  it('separates positional slots from catalogue templates', () => {
    const { slots, templates } = scopedTokensOf('bind ${ALPHA} and render {{BETA}}');
    expect([...slots]).toEqual(['ALPHA']);
    expect([...templates]).toEqual(['BETA']);
  });

  it('never excuses a positional slot because a sibling still has it', () => {
    // `${}` binds into THIS prompt's site, so set-wide presence is irrelevant.
    expect(lostTokens(['bind ${ALPHA}'], 'bind nothing', new Set(['ALPHA']))).toEqual(['ALPHA']);
  });

  it('excuses a catalogue template that survives elsewhere in the set', () => {
    // The 2.1.237 shape: data-managed-agents-environments-and-resources dropped
    // its only {{OPUS_ID}} with a TypeScript sample fence, while the CreateAgent
    // schema in data-managed-agents-endpoint-reference still carries it.
    expect(
      lostTokens(["model: '{{OPUS_ID}}'"], 'fence deleted', new Set(['OPUS_ID']))
    ).toEqual([]);
  });

  it('still reports a template that survives nowhere in the set', () => {
    expect(lostTokens(['on {{MYTHOS_NAME}}'], 'sentence deleted', new Set())).toEqual([
      'MYTHOS_NAME',
    ]);
  });

  it('falls back to per-file scoping when the caller cannot see the set', () => {
    expect(lostTokens(['on {{MYTHOS_NAME}}'], 'sentence deleted')).toEqual(['MYTHOS_NAME']);
  });
});

describe('checkTrimSlots: nested template slots', () => {
  const pristine =
    'Read files ${HAS_READ_TOOL?`with ${READ_TOOL_NAME} before editing`:""} and then edit.';

  it('collects a slot that only appears inside a ternary-nested template', () => {
    expect([...scopedTokensOf(pristine).slots].sort()).toEqual(['HAS_READ_TOOL', 'READ_TOOL_NAME']);
  });

  it('does not report the nested slot as lost when the override keeps the ternary', () => {
    expect(lostTokens([pristine], 'Edit ${HAS_READ_TOOL?`after ${READ_TOOL_NAME}`:""}.')).toEqual([]);
  });

  it('does not report it as lost when the override hoists the nested slot to top level', () => {
    expect(lostTokens([pristine], 'Use ${READ_TOOL_NAME} ${HAS_READ_TOOL?"first":""}.')).toEqual([]);
  });

  it('still reports the nested slot when the override drops it from the ternary', () => {
    expect(lostTokens([pristine], 'Edit ${HAS_READ_TOOL?`carefully`:""}.')).toEqual(['READ_TOOL_NAME']);
  });

  it('counts a nested slot the override moved into a bare ternary arm', () => {
    const p = '${CITATIONS?`- ${UNTRUSTED_NOTE}\n`:`add a Sources section`}';
    expect(lostTokens([p], '${CITATIONS?UNTRUSTED_NOTE:"end with Sources"}')).toEqual([]);
  });

  it('reports a bare ternary-arm slot the override dropped', () => {
    expect(lostTokens(['${CITATIONS?UNTRUSTED_NOTE:""}'], '${CITATIONS?"cite":""}')).toEqual([
      'UNTRUSTED_NOTE',
    ]);
  });

  it('descends any depth and reads catalogue templates inside slot strings', () => {
    const { slots, templates } = scopedTokensOf(
      '${A?`a ${B>0?`deep ${C(D)}`:""}`:"use {{OPUS_ID}}"}'
    );
    expect([...slots].sort()).toEqual(['A', 'B', 'C']);
    expect([...templates]).toEqual(['OPUS_ID']);
  });

  it('falls back to the leading identifier when the slot is not a JS expression', () => {
    expect([...scopedTokensOf('run ${foo:-bar} in ${HOME}').slots].sort()).toEqual(['HOME', 'foo']);
  });
});
