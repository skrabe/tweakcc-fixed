// The release-notes changelog is a DOCUMENT, not a prompt: `Inn()` feeds only
// computeUpdateSummary -> the startup "what's new" notice, and reaches no system
// prompt, tool schema or tool result.
//
// It is also the one string in the bundle guaranteed to QUOTE other prompts,
// because release notes describe prompt-level fixes by quoting the prompt. On CC
// 2.1.266 a /rewind note quoted "File unchanged since last read", which satisfied
// the curated NEW_PROMPT_ASSIGNMENTS matcher for `tool-result-read-file-unchanged`.
// A curated assignment outranks the classification cache AND the prose gate, so a
// `ui` verdict could not suppress it: the 95KB changelog was captured under that
// prompt's id and pushed the real 154-char prompt out to a `-2` suffix.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ex = require('./promptExtractor.js');

const CHANGELOG = [
  '## 2.1.263',
  '- Bug fixes and reliability improvements',
  '',
  '## 2.1.261',
  '- Fixed `/rewind` leaving stale file-read tracking from the rewound-away turns,',
  '  which caused "File unchanged since last read" stubs and full-file re-injection',
  '',
  '## 2.1.259',
  '- Added an "Organization policy" line to `/status`',
  '',
  '## 2.1.257',
  '- Bug fixes',
  '',
  '## 2.1.252',
  '- Bug fixes',
  '',
  '## 2.1.251',
  '- Bug fixes',
].join('\n');

const REAL_PROMPT =
  'File unchanged since last read. The content from the earlier Read tool_result ' +
  'in this conversation is still current, so refer to it instead of reading again.';

describe('the release-notes changelog is never captured as a prompt', () => {
  it('hard-excludes a multi-entry changelog by shape', () => {
    expect(ex.isHardExcluded(CHANGELOG)).toBe(true);
  });

  it('does not hard-exclude a prompt that merely opens with a heading', () => {
    expect(
      ex.isHardExcluded('## Usage notes\n\nAlways pass the tool a description.')
    ).toBe(false);
  });

  it('leaves the real file-unchanged prompt capturable', () => {
    expect(ex.isHardExcluded(REAL_PROMPT)).toBe(false);
  });
});

describe('a curated assignment cannot be claimed by a document quoting it', () => {
  it('still matches the real prompt', () => {
    const hit = ex.lookupNewPromptAssignment(REAL_PROMPT);
    expect(hit && hit.id).toBe('tool-result-read-file-unchanged');
  });

  // The general rule, not just this one entry: a curated matcher outranks every
  // other gate, so ANY assignment a longer document can satisfy is a latent
  // force-capture that no verdict can undo. A bare `includes` on a quotable
  // phrase is exactly that shape.
  it('is not claimed by the changelog that quotes it', () => {
    expect(CHANGELOG).toContain('File unchanged since last read');
    expect(ex.lookupNewPromptAssignment(CHANGELOG)).toBeFalsy();
  });
});
