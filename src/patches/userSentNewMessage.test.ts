// Integration test (no sibling patch file): exercises the `user-sent-new-message`
// system-reminder override — a REMINDER_REGISTRY entry in systemReminderOverrides,
// not a standalone patch — so src/patches/userSentNewMessage.ts does not exist.
import { describe, it, expect } from 'vitest';
import { REMINDER_REGISTRY } from './systemReminderOverrides';

const injection = REMINDER_REGISTRY.find(
  r => r.id === 'user-sent-new-message'
)!;

// The substituted override body (substitutePlaceholders turns `{{message}}` into
// the `${H}` interpolation the apply() then rebinds to the matched delta param).
const defaultBody =
  'The user sent a new message while you were working:\n${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.";

// 2.1.169 shape: `case"auto-continuation":` prepended, `default:` split into its
// own [MESSAGE FROM NON-USER SOURCE] case after the user-message return.
const cli2169 =
  'case"auto-continuation":case"human":case void 0:return`The user sent a new message while you were working:\n${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;" +
  'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${H}`}';

// <=2.1.168 shape: no auto-continuation prefix, `default:` falls through to the
// user-message return.
const cli2168 =
  'case"human":case void 0:default:return`The user sent a new message while you were working:\n${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;";

// 2.1.177 shape: the intro line is hoisted into a standalone `$Tq` var, so the
// return reads `${$Tq}${H}` instead of inlining the English text.
const cli2177 =
  'case"auto-continuation":case"human":case void 0:return`${$Tq}${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;" +
  'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${H}`}';

describe('user-sent-new-message reminder injection', () => {
  it('preserves the 2.1.169 case-label prefix (and leaves the split default case intact)', () => {
    const out = injection.apply(cli2169, defaultBody, false)!;
    expect(out).not.toBeNull();
    // Prefix captured + reused verbatim — NOT hardcoded to the old shape.
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`'
    );
    expect(out).not.toContain('case void 0:default:return`The user sent');
    // The separate non-user-source default case must survive untouched.
    expect(out).toContain(
      'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]'
    );
  });

  it('still matches the <=2.1.168 case-label prefix (fallback shape)', () => {
    const out = injection.apply(cli2168, defaultBody, false)!;
    expect(out).not.toBeNull();
    expect(out).toContain('case"human":case void 0:default:return`');
    expect(out).not.toContain('auto-continuation');
  });

  it('suppression collapses to just the message param, prefix preserved', () => {
    const out = injection.apply(cli2169, defaultBody, true)!;
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`${H}`'
    );
    expect(out).not.toContain('The user sent a new message');
  });

  it('matches the 2.1.177 hoisted-intro (${$Tq}) shape', () => {
    const out = injection.apply(cli2177, defaultBody, false)!;
    expect(out).not.toBeNull();
    // The hoisted `${$Tq}${H}` intro is replaced by the override body, prefix kept.
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`The user sent a new message while you were working:'
    );
    expect(out).not.toContain('${$Tq}');
    expect(out).toContain(
      'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]'
    );
  });

  it('suppresses the 2.1.177 hoisted-intro shape to the bare message', () => {
    const out = injection.apply(cli2177, defaultBody, true)!;
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`${H}`'
    );
    expect(out).not.toContain('${$Tq}');
    expect(out).not.toContain('The user sent a new message');
  });
});
