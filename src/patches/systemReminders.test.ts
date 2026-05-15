import { describe, it, expect } from 'vitest';
import {
  writeClaudemdContextOncePerConversation,
  writeStripEmptySystemReminders,
  writeSuppressDeferredTools,
} from './systemReminders';

// Verbatim spans from CC 2.1.141's cli.js.

const MOCK_LW =
  'return"responding";return}}function LW(H){return`<system-reminder>\n${H}\n</system-reminder>`}function S8K(H){let _=/^<system-reminder>\\n?/;return _}';

const MOCK_DEFERRED =
  'case"deferred_tools_delta":{let q=[];' +
  'if(H.addedLines.length>0)q.push(`The following deferred tools are now available via ${cz}. ' +
  'Their schemas are NOT loaded.`);' +
  'if(q.length===0)return[];return o5([j6({content:q.join(`\n\n`),isMeta:!0})])}';

// Verbatim hY6 wrapper from CC 2.1.142's cli.js.
const MOCK_KY6 =
  'function hY6(H,_){if(Object.entries(_).length===0)return H;return[' +
  'j6({content:`<system-reminder>\n' +
  "As you answer the user's questions, you can use the following context:\n" +
  '${Object.entries(_).map(([q,K])=>`# ${q}\n${K}`).join(`\n`)}\n\n' +
  '      IMPORTANT: this context may or may not be relevant to your tasks. ' +
  'You should not respond to this context unless it is highly relevant to your task.\n' +
  '</system-reminder>\n`,isMeta:!0}),...H]}' +
  'async function bhK(H,_){if(Su())return;d("tengu_context_size",{git_status_size:0});}';

describe('systemReminders kill-switches', () => {
  describe('writeStripEmptySystemReminders', () => {
    it('short-circuits LW for empty / (no content) input, returning unwrapped placeholder', () => {
      const result = writeStripEmptySystemReminders(MOCK_LW);
      expect(result).not.toBeNull();
      expect(result).toContain(
        'function LW(H){if(!H||!H.trim()||H==="(no content)")return"(no content)";return`<system-reminder>\n${H}\n</system-reminder>`}'
      );
    });

    it('is idempotent', () => {
      const once = writeStripEmptySystemReminders(MOCK_LW)!;
      expect(writeStripEmptySystemReminders(once)).toBe(once);
    });

    it('tolerates renamed identifiers', () => {
      const renamed = MOCK_LW.replace(/\bLW\b/g, 'a$Z')
        .replace(/\(H\)/g, '(Q)')
        .replace(/\$\{H\}/g, '${Q}');
      const result = writeStripEmptySystemReminders(renamed);
      expect(result).not.toBeNull();
      expect(result).toContain(
        'if(!Q||!Q.trim()||Q==="(no content)")return"(no content)";'
      );
    });

    it('returns null when LW shape not found', () => {
      expect(writeStripEmptySystemReminders('unrelated')).toBeNull();
    });
  });

  describe('writeSuppressDeferredTools', () => {
    it('injects early return inside the case body', () => {
      const result = writeSuppressDeferredTools(MOCK_DEFERRED);
      expect(result).not.toBeNull();
      expect(result).toContain(
        'case"deferred_tools_delta":{return [];let q=[];'
      );
    });

    it('is idempotent', () => {
      const once = writeSuppressDeferredTools(MOCK_DEFERRED)!;
      expect(writeSuppressDeferredTools(once)).toBe(once);
    });

    it('no-ops when anchor absent', () => {
      const out = writeSuppressDeferredTools('nothing');
      expect(out).toBe('nothing');
    });
  });

  describe('writeClaudemdContextOncePerConversation', () => {
    it('rewrites the wrapper to detect sysRem at H[0] and mutate-unshift on absence', () => {
      const result = writeClaudemdContextOncePerConversation(MOCK_KY6);
      expect(result).not.toBeNull();
      // Early return on empty ctx (preserved).
      expect(result).toContain(
        'function hY6(H,_){if(Object.entries(_).length===0)return H;'
      );
      // Aliases H[0] for inspection.
      expect(result).toContain('var H_0=H[0];');
      // Skips re-inject when sysRem already at the start.
      expect(result).toContain(
        'if(H_0&&H_0.isMeta&&H_0.message&&typeof H_0.message.content==="string"&&H_0.message.content.indexOf("<system-reminder>\\nAs you answer the user")===0)return H'
      );
      // Unshifts j6(...) into H so it persists across turns.
      expect(result).toContain('H.unshift(j6({content:`<system-reminder>');
      // Returns H (the mutated array), not a fresh [...].
      expect(result).toContain('</system-reminder>\n`,isMeta:!0}));return H}');
      // The vanilla "return[j6(...),...H]" must be gone -- that was the bug.
      expect(result).not.toMatch(/return\[j6\(\{content:`<system-reminder>/);
    });

    it('actually persists sysRem across simulated multi-round calls and handles bootstrap-prepended arrays', () => {
      // Eval the patched function. Three scenarios:
      //  1. Headless bootstrap: H starts with bootstrap progress/attachment
      //     frames preceding the user message. length > 1, no sysRem -> inject.
      //  2. Mid-turn (after assistant response): sysRem at H[0] from previous
      //     call -> no-op.
      //  3. Next user turn (more messages added at the end): sysRem still at
      //     H[0] -> no-op.
      const patched = writeClaudemdContextOncePerConversation(MOCK_KY6)!;
      const fnBody = patched.match(
        /function hY6\(H,_\)\{[\s\S]+?return H\}/
      )![0];
      const j6 = (msg: { content: string; isMeta: boolean }) => ({
        type: 'user' as const,
        message: { role: 'user', content: msg.content },
        isMeta: msg.isMeta,
      });
      const hY6 = new Function('j6', `${fnBody}; return hY6;`)(j6);
      const ctx = { claudeMd: '# my rules', userEmail: 'a@b.c' };

      // Scenario 1: bootstrap-style starting array (length 7, headless mode).
      const msgs: unknown[] = [
        { type: 'progress' },
        { type: 'progress' },
        { type: 'attachment' },
        { type: 'attachment' },
        { type: 'user', message: { role: 'user', content: 'hello' } },
        { type: 'attachment' },
        { type: 'attachment' },
      ];
      const round1 = hY6(msgs, ctx);
      expect(round1).toBe(msgs); // mutated, same reference
      expect(round1.length).toBe(8); // sysRem unshifted to front
      expect((round1[0] as { isMeta: boolean }).isMeta).toBe(true);
      expect(
        (round1[0] as { message: { content: string } }).message.content
      ).toContain('# claudeMd');
      expect(
        (round1[0] as { message: { content: string } }).message.content
      ).toContain('my rules');

      // Scenario 2: mid-turn. Assistant response appended after first call.
      msgs.push({
        type: 'assistant',
        message: { role: 'assistant', content: 'hi back' },
      });
      const round2 = hY6(msgs, ctx);
      expect(round2).toBe(msgs);
      expect(round2.length).toBe(9); // no second sysRem unshift
      expect((round2[0] as { isMeta: boolean }).isMeta).toBe(true);

      // Scenario 3: next user turn. New user message appended.
      msgs.push({
        type: 'user',
        message: { role: 'user', content: 'second turn' },
      });
      const round3 = hY6(msgs, ctx);
      expect(round3).toBe(msgs);
      expect(round3.length).toBe(10);
      expect((round3[0] as { isMeta: boolean }).isMeta).toBe(true);
    });

    it('is idempotent', () => {
      const once = writeClaudemdContextOncePerConversation(MOCK_KY6)!;
      expect(writeClaudemdContextOncePerConversation(once)).toBe(once);
    });

    it('tolerates renamed identifiers', () => {
      const renamed = MOCK_KY6.replace(/\bhY6\b/g, 'a$Z')
        .replace(/\(H,_\)/g, '(Q,V)')
        .replace(/Object\.entries\(_\)/g, 'Object.entries(V)')
        .replace(/return H/g, 'return Q')
        .replace(/\.\.\.H\]/g, '...Q]');
      const result = writeClaudemdContextOncePerConversation(renamed);
      expect(result).not.toBeNull();
      expect(result).toContain('var Q_0=Q[0];');
      expect(result).toContain('Q.unshift(j6(');
    });

    it('returns null and logs when wrapper is missing entirely', () => {
      const result =
        writeClaudemdContextOncePerConversation('totally unrelated');
      expect(result).toBeNull();
    });

    it('no-ops when claudemd-context override has suppressed the wrapper', () => {
      const suppressed =
        'function hY6(H,_){return H;}async function bhK(H,_){if(Su())return;d("tengu_context_size",{git_status_size:0});}';
      const result = writeClaudemdContextOncePerConversation(suppressed);
      expect(result).toBe(suppressed);
    });
  });
});
