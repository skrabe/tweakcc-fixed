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
