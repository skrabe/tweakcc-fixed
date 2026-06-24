import { describe, it, expect } from 'vitest';
import { REMINDER_REGISTRY } from './systemReminderOverrides';

const memoryUpdate = REMINDER_REGISTRY.find(r => r.id === 'memory-update')!;

// Memory_update case shaped like CC 2.1.177's cli.js: the wrapper call is
// preceded by a comma-expression (`return K.push(rm6),HT([U6(...`), unlike the
// other reminder cases which emit `return X([Y(...` directly. discoverWrappers
// used to anchor on `return X([` and so missed this, falling back to the stale
// hardcoded o5/j6 and crashing at runtime with "j6 is not a function".
const MOCK_COMMA_EMIT =
  'case"memory_update":{let K=[`${OSO[H.source]} updated your memory directory: ${H.summary}`];' +
  'return K.push(rm6),HT([U6({content:K.join(`\\n`),isMeta:!0})])}';

// Same case with the wrapper emitted directly after `return` (other builds).
const MOCK_DIRECT_EMIT =
  'case"memory_update":{let K=`updated your memory directory`;' +
  'return HT([U6({content:K,isMeta:!0})])}';

describe('memory-update reminder wrapper discovery', () => {
  it('reads the real wrapper/ctor past a comma-expression, not the o5/j6 fallback', () => {
    const result = memoryUpdate.apply(MOCK_COMMA_EMIT, 'memory changed', false);
    expect(result).not.toBeNull();
    expect(result).toContain('HT([U6({content:');
    expect(result).not.toContain('o5([j6(');
  });

  it('still reads a wrapper emitted directly after return', () => {
    const result = memoryUpdate.apply(
      MOCK_DIRECT_EMIT,
      'memory changed',
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain('HT([U6({content:');
  });
});

const taskNotif = REMINDER_REGISTRY.find(
  r => r.id === 'task-notification-framing'
)!;

const NOTIF_BODY =
  '[SYSTEM NOTIFICATION - NOT USER INPUT]\n' +
  'This is an automated background-task event, NOT a message from the user.\n' +
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\n';

// 2.1.183 hoisted the inline body into a standalone framing function
// `function MBl(e){return`…${e}`}` (case site: `return MBl(e);`).
const MOCK_NOTIF_FN_2_1_183 =
  'function MBl(e){return`' + NOTIF_BODY + '${e}`}function NBl(){}';

// <=2.1.182 inline shape: `case"task-notification":return`…${H}`;`.
const MOCK_NOTIF_INLINE =
  'switch(t){case"task-notification":return`' + NOTIF_BODY + '${H}`;default:}';

describe('task-notification-framing wrapper discovery', () => {
  it('rewrites the 2.1.183 standalone framing function in place, preserving ${param} and the `}` suffix', () => {
    const result = taskNotif.apply(MOCK_NOTIF_FN_2_1_183, 'PREFIX ${H}', false);
    expect(result).not.toBeNull();
    expect(result).toContain('function MBl(e){return`PREFIX ${e}`}');
    // sibling function untouched
    expect(result).toContain('function NBl(){}');
  });

  it('still rewrites the <=2.1.182 inline case shape', () => {
    const result = taskNotif.apply(MOCK_NOTIF_INLINE, 'PREFIX ${H}', false);
    expect(result).not.toBeNull();
    expect(result).toContain('case"task-notification":return`PREFIX ${H}`;');
  });

  it('suppresses to a bare `${param}` on the function shape (empty body)', () => {
    const result = taskNotif.apply(MOCK_NOTIF_FN_2_1_183, '${H}', true);
    expect(result).toContain('function MBl(e){return`${e}`}');
  });

  it('fails loud (null) when the framing body text changed', () => {
    const drifted = 'function MBl(e){return`[DIFFERENT FRAMING]\n${e}`}';
    expect(taskNotif.apply(drifted, 'x ${H}', false)).toBeNull();
  });
});

const selectedLines = REMINDER_REGISTRY.find(
  r => r.id === 'selected-lines-in-ide'
)!;

// Body the runtime hands `apply`: the defaultBody with placeholders already
// substituted to their `${H.x}` / `${q}` expressions by substitutePlaceholders.
const SELECTED_LINES_BODY =
  'The user selected the lines ${H.lineStart} to ${H.lineEnd} from ' +
  '${H.filename}:\n${q}\n\nThis may or may not be related to the current task.';

// 2.1.186+ direct-arrow shape: the truncation `{let q=…substring(0,2000)…}`
// wrapper is gone and the selected-text slot is an inlined function call
// (`${k6l(e.content)}`) rather than a local var.
const MOCK_SELECTED_NEW_2_1_186 =
  'selected_lines_in_ide:(e)=>sp([Ln({content:`The user selected the lines ' +
  '${e.lineStart} to ${e.lineEnd} from ${e.filename}:\n${k6l(e.content)}\n\n' +
  'This may or may not be related to the current task.`,isMeta:!0})])';

// <=2.1.185 shape: truncated content >2000 chars into a local `q` before emit.
const MOCK_SELECTED_OLD_2_1_185 =
  'selected_lines_in_ide:(H)=>{let q=H.content.length>2000?' +
  'H.content.substring(0,2000)+`\n... (truncated)`:H.content;' +
  'return o5([j6({content:`The user selected the lines ${H.lineStart} to ' +
  '${H.lineEnd} from ${H.filename}:\n${q}\n\nThis may or may not be related ' +
  'to the current task.`,isMeta:!0})])}';

// The sibling diff handler shares the trailing English; the patch must not
// rewrite it (anchored on `selected_lines_in_ide:` + the distinct phrasing).
const MOCK_SELECTED_DIFF_SIBLING =
  'selected_lines_in_diff:(e)=>sp([Ln({content:`The user selected the ' +
  'following ${e.lineCount} ${e.lineCount===1?"line":"lines"} from the diff ' +
  'view:\n${k6l(e.content)}\n\nThis may or may not be related to the current ' +
  'task.`,isMeta:!0})])';

describe('selected-lines-in-ide reminder shape handling', () => {
  it('rewrites the 2.1.186 direct-arrow shape, inlining the captured content expression for ${q}', () => {
    const result = selectedLines.apply(
      MOCK_SELECTED_NEW_2_1_186,
      SELECTED_LINES_BODY,
      false
    );
    expect(result).not.toBeNull();
    // Default body round-trips to the exact pristine code.
    expect(result).toBe(MOCK_SELECTED_NEW_2_1_186);
    // No stale `{let q=…}` wrapper or substring(0,2000) reintroduced.
    expect(result).not.toContain('substring(0,2000)');
    expect(result).toContain('${k6l(e.content)}');
  });

  it('maps a customized body onto the new shape, preserving the inlined content expression', () => {
    const custom =
      'SELECTED ${H.lineStart}-${H.lineEnd} in ${H.filename}:\n${q}';
    const result = selectedLines.apply(
      MOCK_SELECTED_NEW_2_1_186,
      custom,
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain(
      'selected_lines_in_ide:(e)=>sp([Ln({content:`SELECTED ' +
        '${e.lineStart}-${e.lineEnd} in ${e.filename}:\n${k6l(e.content)}`'
    );
  });

  it('suppresses the new shape to a bare empty-array arrow', () => {
    const result = selectedLines.apply(
      MOCK_SELECTED_NEW_2_1_186,
      SELECTED_LINES_BODY,
      true
    );
    expect(result).toContain('selected_lines_in_ide:(e)=>[]');
  });

  it('still rewrites the <=2.1.185 truncating shape via the fallback', () => {
    const result = selectedLines.apply(
      MOCK_SELECTED_OLD_2_1_185,
      SELECTED_LINES_BODY,
      false
    );
    expect(result).not.toBeNull();
    // Round-trips to pristine, keeping the truncation wrapper + local `q`.
    expect(result).toBe(MOCK_SELECTED_OLD_2_1_185);
  });

  it('does not touch the selected_lines_in_diff sibling', () => {
    expect(
      selectedLines.apply(
        MOCK_SELECTED_DIFF_SIBLING,
        SELECTED_LINES_BODY,
        false
      )
    ).toBeNull();
  });
});

describe('verify-plan reminder removed-feature handling', () => {
  const verifyPlan = REMINDER_REGISTRY.find(
    r => r.id === 'verify-plan-reminder'
  )!;

  // CC 2.1.187 gutted the verify-plan reminder: `verify_plan_reminder` survives
  // only as a type label with no case body / no injected text. The patch must
  // no-op (return content unchanged) instead of failing, so the apply log stays
  // clean on current CC while older supported CC (< 2.1.187) still patches.
  it('no-ops when the verify-plan case body was removed (CC 2.1.187)', () => {
    const removed =
      'function r(){return["plan_mode_enter","plan_mode_exit","verify_plan_reminder"]}';
    expect(verifyPlan.apply(removed, 'body', false)).toBe(removed);
    // Suppression path also no-ops rather than failing.
    expect(verifyPlan.apply(removed, '', true)).toBe(removed);
  });

  // But if the anchor text is still present and the case shape is unmatched,
  // that's a real shape drift on a build that still has the feature — surface it.
  it('still fails (null) on real drift when the anchor text is present', () => {
    const drifted =
      'case"other":You have completed implementing the plan but the shape changed';
    expect(verifyPlan.apply(drifted, 'body', false)).toBeNull();
  });
});
