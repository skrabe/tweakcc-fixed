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

// 2.1.176+ shape: upstream hoisted "The user sent a new message while you were
// working:\n" out of the template literal into a separate variable (e.g. $Tq /
// OTq). The return now reads `return\`${VAR}${H}\n\n...\`` where VAR holds the
// hoisted first sentence.
const cli2177hoisted =
  'case"auto-continuation":case"human":case void 0:return`${$Tq}${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;" +
  'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${H}`}';

// Same hoisted form with a different minified VAR identifier (2.1.176).
const cli2176hoisted =
  'case"auto-continuation":case"human":case void 0:return`${OTq}${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;" +
  'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${H}`}';

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

describe('user-sent-new-message reminder injection', () => {
  it('matches the 2.1.177 hoisted form (VAR holds the leading sentence)', () => {
    const out = injection.apply(cli2177hoisted, defaultBody, false)!;
    expect(out).not.toBeNull();
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`'
    );
    // Override body should be re-inlined (not the hoisted form)
    expect(out).toContain(
      'The user sent a new message while you were working:'
    );
    // Hoisted VAR interpolation should be gone from the return
    expect(out).not.toContain('${$Tq}');
    // Split default case must survive untouched
    expect(out).toContain(
      'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]'
    );
  });

  it('matches the 2.1.176 hoisted form (different minified VAR)', () => {
    const out = injection.apply(cli2176hoisted, defaultBody, false)!;
    expect(out).not.toBeNull();
    expect(out).toContain(
      'The user sent a new message while you were working:'
    );
    expect(out).not.toContain('${OTq}');
  });

  it('suppresses the 2.1.177 hoisted form to just the message param', () => {
    const out = injection.apply(cli2177hoisted, defaultBody, true)!;
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`${H}`'
    );
    expect(out).not.toContain('The user sent a new message');
    expect(out).not.toContain('${$Tq}');
  });

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
});
