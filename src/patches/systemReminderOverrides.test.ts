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
