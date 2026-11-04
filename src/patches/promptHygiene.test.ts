import { describe, expect, it } from 'vitest';
import { normalizeRecordedPrompt } from './promptHygiene';

const empty = '# Environment\n - \n - \n - \n\n';
const context = '# Context management\nContinue across compaction.';

describe('recorded native prompt hygiene', () => {
  it('removes the native scaffold stored as its own snapshot fragment', () => {
    const prompt = ['Native root.', empty.slice(0, -2), context];
    expect(normalizeRecordedPrompt(prompt, [])).toEqual([
      'Native root.',
      context,
    ]);
    expect(prompt).toHaveLength(3);
  });

  it.each(['', 'Native instructions.\n\n'])(
    'removes the known empty native section before context management',
    prefix => {
      const original = [prefix + empty + context];
      const normalized = normalizeRecordedPrompt(original, []);
      expect(normalized).toEqual([prefix + context]);
      expect(original).toEqual([prefix + empty + context]);
      expect(normalizeRecordedPrompt(normalized, [])).toBe(normalized);
    }
  );

  it.each([
    empty.replace(' - \n', ' - Real environment data.\n') + context,
    '# Environment\n - Platform: linux\n\n' + context,
    empty + '# Custom section\nCustom prose.',
    'Example: ' + empty + context,
  ])('preserves runtime data and unmatched custom text: %s', text => {
    const prompt = [text];
    expect(normalizeRecordedPrompt(prompt, [])).toBe(prompt);
  });
});
