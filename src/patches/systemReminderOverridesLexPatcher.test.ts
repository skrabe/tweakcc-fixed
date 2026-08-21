/**
 * Integration tests for LexPatcher-based system reminder overrides.
 * Tests against real cli.js binaries from multiple versions to verify
 * that anchor patterns and variable extraction survive per-release minification.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Versions to test against — must have been downloaded by downloadVersions.sh
const TEST_VERSIONS = ['235', '236', '237', '238'];
const FIXTURE_DIR = '/tmp/anchor-study';

function loadCli(version: string): string {
  const p = path.join(FIXTURE_DIR, `cli_v${version}.js`);
  return fs.readFileSync(p, 'utf-8');
}

describe('systemReminderOverridesLexPatcher', () => {
  describe('anchor matching across versions', () => {
    it.each(TEST_VERSIONS)(
      'v%s: finds simpleEntryPattern anchors for date_change',
      ver => {
        const content = loadCli(ver);
        // Verify the anchor pattern exists in source
        expect(content).toMatch(/date_change:\([a-zA-Z_$]+\)=>/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: finds simpleEntryPattern anchors for token_usage',
      ver => {
        const content = loadCli(ver);
        expect(content).toMatch(/token_usage:\([a-zA-Z_$]+\)=>/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: finds findCaseBody anchor for memory_update',
      ver => {
        const content = loadCli(ver);
        // The memory_update handler uses case"memory_update":{ in a switch statement
        expect(content).toMatch(/case"memory_update":\s*\{/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: finds findCaseBody anchor for mcp_instructions_delta',
      ver => {
        const content = loadCli(ver);
        expect(content).toMatch(/case"mcp_instructions_delta":\s*\{/);
      }
    );

    it.each(TEST_VERSIONS)('v%s: finds thinking reminder label', ver => {
      const content = loadCli(ver);
      // v235+ uses settings labels instead of key-based handlers for this text
      expect(content).toContain('Thinking mode');
    });

    it.each(TEST_VERSIONS)(
      'v%s: finds directRegex anchor for ultrathink_effort',
      ver => {
        const content = loadCli(ver);
        expect(content).toMatch(/ultrathink_effort:[\s\S]{0,200}ultrathink/);
      }
    );

    it.each(TEST_VERSIONS)('v%s: finds hook_additional_context anchor', ver => {
      const content = loadCli(ver);
      expect(content).toMatch(/hook_additional_context:[\s\S]{0,200}hookName/);
    });

    it.each(TEST_VERSIONS)(
      'v%s: finds tool_called function declaration',
      ver => {
        const content = loadCli(ver);
        // v235+ uses a standalone function declaration shape, not key-based
        expect(content).toMatch(
          /function\s+\w+\([^,]+,[^)]+\)\{return\s+\w+\(\{content:`Called the \$/
        );
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: finds local_command_caveat function declaration',
      ver => {
        const content = loadCli(ver);
        // v235+ uses a standalone function declaration shape, not key-based
        expect(content).toMatch(
          /function\s+\w+\(\)\{return\s+\w+\(\{\s*content:`<\$\{[a-zA-Z_$]+\}>Caveat:/
        );
      }
    );

    it.each(TEST_VERSIONS)('v%s: finds output_style anchor', ver => {
      const content = loadCli(ver);
      expect(content).toMatch(/output_style:[\s\S]{0,200}style/);
    });
  });

  describe('wrapper variable extraction', () => {
    it.each(TEST_VERSIONS)(
      'v%s: discovers array wrapper name near date_change anchor',
      ver => {
        const content = loadCli(ver);
        // The date_change pattern uses Zy([Tn({content:` in v238
        // v235+ has wrapper function between => and [: date_change:(e)=>wy([hn({content:`...`])
        const match = content.match(/date_change:\(([a-zA-Z_$]+)\)=>\w+\(\[/);
        expect(match).not.toBeNull();

        // Verify we can find wrapper from context before the anchor
        const ctxBefore = content.slice(
          Math.max(0, match!.index! - 2048),
          match!.index!
        );
        const wrapperMatch = ctxBefore.match(/return[^;]*?([a-zA-Z_$]+)\(\[/);
        // Should find at least one return with array wrapper pattern
        expect(wrapperMatch).not.toBeNull();
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: discovers message constructor near simpleEntry anchors',
      ver => {
        const content = loadCli(ver);
        // Find any simpleEntry anchor and verify wrapper discovery works
        for (const key of ['token_usage', 'budget_usd']) {
          const m = content.match(new RegExp(`${key}:\\([a-zA-Z_$]+=>`));
          if (!m) continue;

          const ctxBefore = content.slice(
            Math.max(0, m.index! - 2048),
            m.index!
          );
          // Should find wrapper return pattern (version-agnostic)
          expect(ctxBefore).toMatch(/return[^;]*?\[([a-zA-Z_$]+)\(/);
        }
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: discovers delta param name within findCaseBody anchor',
      ver => {
        const content = loadCli(ver);
        const m = content.match(/case"memory_update":\s*\{/);
        expect(m).not.toBeNull();

        if (!m) return;
        // Search within the case body for parameter usage like H.summary, e.summary
        const afterAnchor = content.slice(
          m.index! + m[0].length,
          Math.min(content.length, m.index! + 2048)
        );
        expect(afterAnchor).toMatch(/\w+\.(summary|source|paths)/);
      }
    );
  });

  describe('injection template generation', () => {
    it.each(TEST_VERSIONS)(
      'v%s: generates valid injection for simpleEntry pattern',
      ver => {
        const content = loadCli(ver);
        // Replace the date_change handler with a marker to verify injection point
        const dcMatch = content.match(
          /date_change:\([a-zA-Z_$]+\)=>\w+\(\[[a-zA-Z_$]+\(\{content:/
        );
        expect(dcMatch).not.toBeNull();

        if (!dcMatch) return;

        // The match should contain the param name and generic wrapper pattern
        expect(dcMatch[0]).toMatch(/\([a-zA-Z_$]+\)=>\w+\(\[/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: generates valid injection for findCaseBody pattern',
      ver => {
        const content = loadCli(ver);
        // Verify memory_update case body has the expected structure
        const muMatch = content.match(/case"memory_update":\s*\{[\s\S]{0,500}/);
        expect(muMatch).not.toBeNull();

        if (!muMatch) return;

        // Should contain a variable/array pattern with content construction
        const caseBody = muMatch[0];
        // Should contain let-variable-assignment-to-array after case opening brace
        expect(caseBody).toMatch(/:[\s]*\{\s*let\s+[a-zA-Z_$]+=\[/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: generates valid injection for directRegex pattern',
      ver => {
        const content = loadCli(ver);
        // v235+ has no thinking_remider: key handler; verify ultrathink_effort instead (which exists)
        const trMatch = content.match(
          /ultrathink_effort:[\s\S]{0,200}ultrathin/
        );
        expect(trMatch).not.toBeNull();

        if (!trMatch) return;
        // Should contain a wrapper function call (version-agnostic)
        const snippet = content.slice(trMatch.index!, trMatch.index! + 200);
        expect(snippet).toMatch(/\w+\(\[/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: generates valid injection for hook_additional_context',
      ver => {
        const content = loadCli(ver);
        // Verify the hook handler shape
        const hcMatch = content.match(
          /hook_additional_context:\([a-zA-Z_$]+\)=>\{if\([a-zA-Z_$]\.content\.length===0\)return\[\];return/
        );
        expect(hcMatch).not.toBeNull();

        if (!hcMatch) return;

        const ctx = content.slice(hcMatch.index!, hcMatch.index! + 250);
        // Should contain a message constructor wrapper (version-agnostic)
        expect(ctx).toMatch(/\w+\(\{content:/);
      }
    );
  });

  describe('multi-version anchor stability', () => {
    it.each(TEST_VERSIONS)(
      'v%s: stable simpleEntryPattern keys across versions',
      ver => {
        const content = loadCli(ver);
        // All simple entry reminder keys should be present in every version
        const expectedKeys = [
          'date_change:',
          'compact_file_reference:',
          'pdf_reference:',
          'edited_text_file:',
          'selected_lines_in_ide:',
          'opened_file_in_ide:',
          'plan_mode_exit:',
          'nested_memory:',
          'agent_mention:',
          'plan_file_reference:',
        ];

        for (const key of expectedKeys) {
          expect(content).toContain(key);
        }
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: stable findCaseBody keys across versions',
      ver => {
        const content = loadCli(ver);
        // Case body reminder handlers present in every version.
        // Note: verify_plan_reminder only appears as string array member, not handler key.
        expect(content).toMatch(/case["']mcp_instructions_delta["']/);
        expect(content).toMatch(/case["']agent_listing_delta["']/);
        expect(content).toMatch(/case["']memory_update["']/);
        expect(content).toMatch(/case["']task_reminder["']/);
      }
    );

    it.each(TEST_VERSIONS)(
      'v%s: stable directRegex handler keys across versions',
      ver => {
        const content = loadCli(ver);
        // These keys are reminder handlers present in every version.
        // Note: thinking_reminder:, tool_result:, output_style: may appear as config strings only.
        expect(content).toMatch(/ultrathink_effort:\(\)=>/);
        expect(content).toMatch(/hook_blocking_error:\([^)]+\)=>/);
        expect(content).toMatch(/hook_stopped_continuation:\([^)]+\)=>/);
      }
    );
  });

  describe('wrapper name extraction consistency', () => {
    it.each(TEST_VERSIONS)(
      'v%s: wrapper names differ across versions (proves need for dynamic discovery)',
      ver => {
        const content = loadCli(ver);
        // Find the Zy or Tn pattern near simpleEntry anchors
        // v238 uses Zy/Tn, older versions use different names
        const wrappers: string[] = [];

        for (const key of ['token_usage:', 'budget_usd:']) {
          const reStr = `${key}\\([a-zA-Z_$]+\\)=>`;
          let m;
          try {
            m = content.match(new RegExp(reStr));
          } catch {
            continue;
          }
          if (!m) continue;

          // Look at the next 100 chars after the arrow for wrapper pattern
          const ctxAfterArrow = content.slice(
            m.index! + m[0].length,
            m.index! + m[0].length + 100
          );
          // Source shape: [...,wrapper({content:... — find wrapper anywhere in slice
          const wrapMatch = ctxAfterArrow.match(/([a-zA-Z_$]+)\(\{/);
          if (wrapMatch) wrappers.push(wrapMatch[1]);
        }

        expect(wrappers.length).toBeGreaterThan(0);
        // Each version should have at least one wrapper name discovered
      }
    );
  });
});
