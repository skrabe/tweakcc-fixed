import { describe, it, expect } from 'vitest';
import {
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
});
