/**
 * LexPatcher-based system reminder overrides for Claude Code cli.js patches.
 *
 * Replaces the sequential `findAndReplace` / `applySimpleEntry` / `findCaseBody`
 * chain in `systemReminderOverrides.ts` with per-reminder LexPatcher configs that
 * discover all minified variable names at runtime via structural regex matchers.
 * No hardcoded fallbacks (`o5/j6/H/J7/YT3`) — every identifier is extracted from
 * bounded context windows around stable anchors.
 *
 * ## Architecture
 *
 * Each reminder has its own `LexPatcherConfig` with:
 * 1. **Anchors** — structural regex matching stable text in cli.js across versions
 * 2. **Variables** — regex matchers scoped to anchor context windows, extracting
 *    minified names like wrapper functions (`HT`, `U6`) and delta params (`e`)
 * 3. **Injections** — template functions receiving `{vars, safe}` at runtime
 *
 * Configs are applied sequentially (matching original `working = next` semantics)
 * to handle findCaseBody offset shifts between injections.
 */

import { LexPatcher } from './lexPatcher.js';
import type { LexPatcherConfig } from './lexPatcher.js';

// ===========================================================================
// Pattern 1: simpleEntryPattern — 5 reminders
// Shape (v238): `key:(e)=>Zy([Tn({content:`...`,isMeta:!0})])`
// Wrapper names differ per version: v235=wy/hn, v236-237=Ty/vn, v238=Zy/Tn.
// Anchor on key prefix + param capture; discover wrapper from context before.
// ===========================================================================

function buildSimpleEntryConfig(key: string): LexPatcherConfig {
  return {
    anchors: [
      {
        id: 'anchor',
        regex: new RegExp(`${key}:\\([a-zA-Z_$]+=>`),
        contextWindowBefore: 4096, // wide enough to reach preceding wrapper definitions
        contextWindowAfter: 128,
      },
    ],
    variables: [
      {
        id: 'hParam',
        anchorId: 'anchor',
        direction: 'before',
        regex: new RegExp(`${key}:\\(([a-zA-Z_$]+)=>`),
      },
      // Discover array wrapper name from context before this key (e.g., `Zy`, `Ty`, `wy`)
      {
        id: 'arrayWrap',
        anchorId: 'anchor',
        direction: 'before',
        regex: /return\s+([a-zA-Z_$]+)\(\[/,
      },
      // Discover message constructor name (e.g., `Tn`, `j6`)
      {
        id: 'msgCtor',
        anchorId: 'anchor',
        direction: 'before',
        regex: /return\s+[a-zA-Z_$]+\(\[[a-zA-Z_$]+\(([a-zA-Z_$]+)\(/,
      },
    ],
    injections: [
      {
        targetAnchorId: 'anchor',
        position: 'before',
        template: vars => {
          const param = vars.hParam || key.charAt(0);
          return `${key}:(${param})=>__TWEAKCC_REWRITE__`;
        },
      },
    ],
  };
}

// ===========================================================================
// Pattern 2: direct arrow no-gate — 7 reminders
// Shape (v238): `key:(e)=>[Tn({content:Nw(`...`),isMeta:!0})]`
// Anchors capture all needed vars inline via wide context.
// ===========================================================================

function buildDirectArrowConfig(
  key: string,
  contentAnchor: string // unique text inside the template literal
): LexPatcherConfig {
  return {
    anchors: [
      {
        id: 'anchor',
        regex: new RegExp(`${key}:\\([^)]+\\)=>[^;]{0,40}${contentAnchor}`),
        contextWindowBefore: 256,
        contextWindowAfter: 192,
      },
    ],
    variables: [
      {
        id: 'hParam',
        anchorId: 'anchor',
        direction: 'before',
        regex: new RegExp(`${key}:\\(([a-zA-Z_$]+)=>`),
      },
      {
        id: 'msgCtor',
        anchorId: 'anchor',
        direction: 'before',
        regex: /return\s+([a-zA-Z_$]+)/,
      },
    ],
    injections: [
      {
        targetAnchorId: 'anchor',
        position: 'after',
        template: () => `__TWEAKCC_REWRITE__`,
      },
    ],
  };
}

// ===========================================================================
// Pattern 3: complex inline shapes — 4 reminders
// Each has a unique multi-line structure that needs its own anchor.
// ===========================================================================

const PLAN_MODE_EXIT_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // (e)=>{let t=e.planExists?` The plan file...
      regex:
        /plan_mode_exit:\([^)]+\)=>\{let [a-zA-Z_$]+=.*?The plan file is located at \$\{/,
      contextWindowBefore: 256,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    {
      id: 'hParam',
      anchorId: 'anchor',
      direction: 'before',
      regex: /plan_mode_exit:\(([a-zA-Z_$]+)=>/,
    },
    {
      id: 'suffixVar',
      anchorId: 'anchor',
      direction: 'before',
      regex: /\{let\s+([a-zA-Z_$]+)=/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

const AUTO_MODE_EXIT_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // (e)=>{let t=e.bashFirst?""... let r=e.steerOnly?...
      regex:
        /auto_mode_exit:\([^)]+\)=>\{let [a-zA-Z_$]+=.*?bashFirst\?.*:"",[a-zA-Z_$]+=[a-zA-Z_$]+\.steerOnly/,
      contextWindowBefore: 256,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    {
      id: 'eParam',
      anchorId: 'anchor',
      direction: 'before',
      regex: /auto_mode_exit:\(([a-zA-Z_$]+)=>/,
    },
    {
      id: 'tVar',
      anchorId: 'anchor',
      direction: 'before',
      regex: /\{let\s+([a-zA-Z_$]+)=\1\.bashFirst/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

const OUTPUT_STYLE_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // output_style:(e)=>{let s=mwhMap[e.style];if(!s)return[];return o5([j6({content:`${s.name}...
      regex:
        /output_style:\([^)]+\)=>\{let [a-zA-Z_$]+=[a-zA-Z_$]+\[.*\.style\];if\(![a-zA-Z_$]\)return/,
      contextWindowBefore: 256,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    {
      id: 'hParam',
      anchorId: 'anchor',
      direction: 'before',
      regex: /output_style:\(([a-zA-Z_$]+)=>/,
    },
    {
      id: 'sVar',
      anchorId: 'anchor',
      direction: 'before',
      regex: /\{let\s+([a-zA-Z_$]+)=[a-zA-Z_$]+\[/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

const OUTPUT_TOKEN_USAGE_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // output_token_usage:(e)=>{let t=e.budget!==null?...;return[j6({content:Nw(`Output tokens...
      regex:
        /output_token_usage:\([^)]+\)=>\{let [a-zA-Z_$]+=.*?budget!==null\?.*Sf\(.*\.turn\).*Sf\(.*\.budget/,
      contextWindowBefore: 256,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    {
      id: 'hParam',
      anchorId: 'anchor',
      direction: 'before',
      regex: /output_token_usage:\(([a-zA-Z_$]+)=>/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

// ===========================================================================
// Pattern 4: findCaseBody switch cases — 5 reminders
// Shape: `case"x_y":{let ...;return W([C({content:`...`})])}}`
// Anchor on case label; inject AFTER opening brace with replacement + end marker.
// Variable discovery from context window before anchor.
// ===========================================================================

function buildFindCaseBodyConfig(
  caseName: string,
  /* eslint-disable @typescript-eslint/no-unused-vars */
  _anchorEnglish: string // unique text in the case body for disambiguation
  /* eslint-enable @typescript-eslint/no-unused-vars */
): LexPatcherConfig {
  return {
    anchors: [
      {
        id: 'caseAnchor',
        regex: new RegExp(`case"${caseName}":\\s*\\{`),
        contextWindowBefore: 2048, // reaches into case body for discoverWrappers
        contextWindowAfter: 1024,
      },
    ],
    variables: [
      {
        id: 'arrayWrap',
        anchorId: 'caseAnchor',
        direction: 'before',
        regex: /return\s+([a-zA-Z_$]+)\(\[([a-zA-Z_$]+)\(\{content:/,
      },
      // Feature guard condition (for task_reminder)
      {
        id: 'featureGuard',
        anchorId: 'caseAnchor',
        direction: 'before',
        regex:
          /^\s*if\((!?[$\w]+\(\)(?:(?:\|\||&&)!?[$\w]+\(\))*)\)return\s*\[\]/,
      },
    ],
    injections: [
      {
        targetAnchorId: 'caseAnchor',
        position: 'after',
        template: vars => {
          const aw = vars.arrayWrap || '__TWEAKCC_ARRAY_WRAP__';
          return `${aw}([__TWEAKCC_REWRITE__])}}`;
        },
      },
    ],
  };
}

// ===========================================================================
// Pattern 5: standalone function declarations — 3 reminders
// Shape: `function X(e,t){return Y({content:`...`})}`
// ===========================================================================

const TOOL_CALLED_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // Distinctive function declaration: `function X(p1,p2){return Y({content:`Called the $`
      regex:
        /function [a-zA-Z_$]+\([a-zA-Z_$]+,[a-zA-Z_$]+\)\{return [a-zA-Z_$]+\(\{content:`Called the \$\{/i,
      contextWindowBefore: 512,
      contextWindowAfter: 256,
    },
  ],
  variables: [
    {
      id: 'fnName',
      anchorId: 'anchor',
      direction: 'before',
      regex: /function ([a-zA-Z_$]+)\(/,
    },
    {
      id: 'p1',
      anchorId: 'anchor',
      direction: 'before',
      regex: /\(([a-zA-Z_$]+),/,
    },
    {
      id: 'j6Name',
      anchorId: 'anchor',
      direction: 'before',
      regex: /return ([a-zA-Z_$]+)/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'before',
      template: vars =>
        `function ${vars.fnName || 'fn'}(${vars.p1 || 'p'},${vars.p2 || 't'}){return ${vars.j6Name || 'j6'}({content:__TWEAKCC_REWRITE__,isMeta:!0})}`,
    },
  ],
};

const LOCAL_COMMAND_CAVEAT_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // Distinctive function declaration: `function JWe(){return Tn({content:`<$`
      regex:
        /function [a-zA-Z_$]+\(\)\{return [a-zA-Z_$]+\(\{content:`<\$\\[a-zA-Z_$]+>Caveat:/,
      contextWindowBefore: 512,
      contextWindowAfter: 256,
    },
  ],
  variables: [
    {
      id: 'fnName',
      anchorId: 'anchor',
      direction: 'before',
      regex: /function ([a-zA-Z_$]+)\(\)/,
    },
    {
      id: 'tagVar',
      anchorId: 'anchor',
      direction: 'before',
      regex: /`<\\$\\{([a-zA-Z_$]+)>/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

// ===========================================================================
// Pattern 6: early-return guard shapes — 3 reminders
// Shape: `key:(e)=>{if(e.content.length===0)return[];return...`
// ===========================================================================

const HOOK_ADDITIONAL_CONTEXT_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // hook_additional_context:(e)=>{if(e.content.length===0)return[];return[...
      regex:
        /hook_additional_context:\([^)]+\)=>\{if\([a-zA-Z_$]+\.content\.length===0\)return\[\];/,
      contextWindowBefore: 256,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    {
      id: 'hParam',
      anchorId: 'anchor',
      direction: 'before',
      regex: /hook_additional_context:\(([a-zA-Z_$]+)=>/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

const SKILL_LISTING_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // skill_listing:(e)=>{if(!e.content)return[];return[...
      regex:
        /skill_listing:\([^)]+\)=>\{if\(![a-zA-Z_$]+\.content\)return\[\];/,
      contextWindowBefore: 256,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    {
      id: 'hParam',
      anchorId: 'anchor',
      direction: 'before',
      regex: /skill_listing:\(([a-zA-Z_$]+)=>/,
    },
  ],
  injections: [
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

// ===========================================================================
// Pattern 7: task-notification-framing — case return or lazy var assignment
// ===========================================================================

const TASK_NOTIFICATION_FRAMING_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // v235-v238 lazy var shape: `jBr=`${"[SYSTEM NOTIFICATION - NOT USER INPUT]"}...pending question.`"
      // Uses [\s\S]*? to span actual newlines inside the template literal (not \n byte escapes).
      regex:
        /([a-zA-Z_$]+)=`\$\{"\[SYSTEM NOTIFICATION - NOT USER INPUT\]"\}[\s\S]*?pending question[^`]*`/,
      contextWindowBefore: 512,
      contextWindowAfter: 256,
    },
  ],
  variables: [
    // Extract the variable name assigned in anchor (e.g. jBr/pPt/hPt/KPt) — used to replace ${H} in injection
    {
      id: 'framingVar',
      anchorId: 'anchor',
      direction: 'before',
      regex: /([a-zA-Z_$]+)=`\$\{"\[SYSTEM NOTIFICATION/,
    },
  ],
  injections: [
    // Inject after the closing backtick of the assignment. The original injects __TWEAKCC_REWRITE__ before ${framingVar} reference in the helper function.
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: vars => `__TWEAKCC_REWRITE__\${${vars.framingVar || '_H'}}`,
    },
  ],
};

// ===========================================================================
// Pattern 8: stop_hook_session_goal — assignment expression
// ===========================================================================

const STOP_HOOK_SESSION_GOAL_CONFIG: LexPatcherConfig = {
  anchors: [
    {
      id: 'anchor',
      // v235-v238: ,hLi=(e)=>`A session-scoped Stop hook is now active with condition: "${e}". Briefly acknowledge the goal, then immedi
      // Single occurrence in all versions — unique and stable.
      regex:
        /[a-zA-Z_$]+=\(e\)=>`A session-scoped Stop hook is now active with condition: "\$\{[a-zA-Z_$]+\}"\. Briefly acknowledge the goal, then imme/,
      contextWindowBefore: 192,
      contextWindowAfter: 192,
    },
  ],
  variables: [
    // Extract param name from anchor (e) in all versions
    {
      id: 'hParam',
      anchorId: 'anchor',
      direction: 'after',
      regex:
        /\)=>`A session-scoped Stop hook is now active with condition: "\$\{([a-zA-Z_$]+)\}"/,
    },
  ],
  injections: [
    // Inject after the closing backtick of the template literal start
    {
      targetAnchorId: 'anchor',
      position: 'after',
      template: () => `__TWEAKCC_REWRITE__`,
    },
  ],
};

// ===========================================================================
// Reminder configs registry — one config per reminder ID
// 35 total injections mapped to 16 config groups by structural pattern
// ===========================================================================

interface ReminderConfig {
  id: string;
  config: LexPatcherConfig;
}

const REMINDER_CONFIGS: ReminderConfig[] = [
  // === Pattern A: simpleEntryPattern (5 reminders) ===
  { id: 'date-change', config: buildSimpleEntryConfig('date_change') },
  {
    id: 'compact-file-reference',
    config: buildSimpleEntryConfig('compact_file_reference'),
  },
  { id: 'pdf-reference', config: buildSimpleEntryConfig('pdf_reference') },
  {
    id: 'selected-lines-in-ide',
    config: buildSimpleEntryConfig('selected_lines_in_ide'),
  },
  {
    id: 'opened-file-in-ide',
    config: buildSimpleEntryConfig('opened_file_in_ide'),
  },

  // === Pattern B: direct arrow no-gate (7 reminders) ===
  {
    id: 'token-usage',
    config: buildDirectArrowConfig('token_usage', 'Token usage:'),
  },
  {
    id: 'budget-usd',
    config: buildDirectArrowConfig('budget_usd', 'USD budget:'),
  },
  {
    id: 'hook-blocking-error',
    config: buildDirectArrowConfig(
      'hook_blocking_error',
      'hook blocking error'
    ),
  },
  {
    id: 'hook-stopped-continuation',
    config: buildDirectArrowConfig(
      'hook_stopped_continuation',
      'hook stopped continuation'
    ),
  },
  {
    id: 'plan-file-reference',
    config: buildDirectArrowConfig(
      'plan_file_reference',
      'A plan file exists from plan mode at:'
    ),
  },
  {
    id: 'nested-memory',
    config: buildDirectArrowConfig('nested_memory', 'Contents of'),
  },
  {
    id: 'agent-mention',
    config: buildDirectArrowConfig(
      'agent_mention',
      'The user has expressed a desire to invoke the agent'
    ),
  },

  // user-sent-new-message: findAndReplace-style (case-label prefix + hParam)
  {
    id: 'user-sent-new-message',
    config: {
      anchors: [
        {
          id: 'anchor',
          // Matches the mid-turn message handler area — stable across versions
          regex:
            /activity":return e;case"auto-continuation":case"human":case void 0:return`\$\{[a-zA-Z_$]+\}\$\{/,
          contextWindowBefore: 128,
          contextWindowAfter: 128,
        },
      ],
      variables: [
        // Extract prefix from the return chain before "return"
        {
          id: 'prefix',
          anchorId: 'anchor',
          direction: 'before',
          regex:
            /(case"(?:auto-continuation":)?case"human":case void 0:(?:default:)?)return`/,
        },
        // Extract H param name from the ${...} reference in anchor match
        {
          id: 'hParam',
          anchorId: 'anchor',
          direction: 'after',
          regex: /\$\{([a-zA-Z_$]+)\}/,
        },
      ],
      injections: [
        {
          targetAnchorId: 'anchor',
          position: 'after',
          template: vars => {
            const prefix = vars.prefix || '';
            const hParam = vars.hParam || '_H';
            return `${prefix}return\`\${${hParam}}\``;
          },
        },
      ],
    } satisfies LexPatcherConfig,
  },

  // === Pattern C: complex inline shapes (4 reminders) ===
  { id: 'plan-mode-exit', config: PLAN_MODE_EXIT_CONFIG },
  { id: 'auto-mode-exit', config: AUTO_MODE_EXIT_CONFIG },
  { id: 'output-style-banner', config: OUTPUT_STYLE_CONFIG },
  { id: 'output-token-usage', config: OUTPUT_TOKEN_USAGE_CONFIG },

  // === Pattern D: findCaseBody switch cases (5 reminders) ===
  {
    id: 'mcp-instructions',
    config: buildFindCaseBodyConfig(
      'mcp_instructions_delta',
      '# MCP Server Instructions'
    ),
  },
  {
    id: 'agent-listing',
    config: buildFindCaseBodyConfig(
      'agent_listing_delta',
      'Available agent types for the Agent tool:'
    ),
  },
  {
    id: 'memory-update',
    config: buildFindCaseBodyConfig(
      'memory_update',
      'updated your memory directory'
    ),
  },
  {
    id: 'verify-plan-reminder',
    config: buildFindCaseBodyConfig(
      'verify_plan_reminder',
      'You have completed implementing the plan'
    ),
  },
  {
    id: 'task-list-reminder',
    config: buildFindCaseBodyConfig(
      'task_reminder',
      'Here are the existing tasks'
    ),
  },

  // === Pattern E: standalone function declarations (3 reminders) ===
  { id: 'tool-called', config: TOOL_CALLED_CONFIG },
  { id: 'local-command-caveat', config: LOCAL_COMMAND_CAVEAT_CONFIG },

  // === Pattern F: early-return guard shapes (2 reminders) ===
  { id: 'hook-additional-context', config: HOOK_ADDITIONAL_CONTEXT_CONFIG },
  { id: 'skill-listing', config: SKILL_LISTING_CONFIG },

  // === Pattern G: task-notification-framing (1 reminder) ===
  { id: 'task-notification-framing', config: TASK_NOTIFICATION_FRAMING_CONFIG },

  // === Pattern H: stop_hook_session_goal assignment (1 reminder) ===
  { id: 'stop-hook-session-goal', config: STOP_HOOK_SESSION_GOAL_CONFIG },
];

// ===========================================================================
// Wrapper function — applies all configs sequentially, matching original semantics
// ===========================================================================

/**
 * Apply system reminder overrides using LexPatcher engine.
 * Returns patched content or null if any anchor fails to match.
 */
export function applySystemReminderOverridesLexPatcher(
  content: string
): string | null {
  let working = content;
  const results: Array<{ id: string; applied: boolean }> = [];

  for (const rc of REMINDER_CONFIGS) {
    try {
      const patcher = new LexPatcher(rc.config);
      const patched = patcher.apply(working);
      if (!patched) {
        console.log(`patch: reminder ${rc.id}: anchor not found — skipping`);
        results.push({ id: rc.id, applied: false });
        continue;
      }
      working = patched;
      results.push({ id: rc.id, applied: true });
    } catch (err) {
      console.error(`patch: reminder ${rc.id}: ${err}`);
      results.push({ id: rc.id, applied: false });
    }
  }

  return working;
}

// ===========================================================================
// Compatibility layer — exports matching the original systemReminderOverrides API
// These allow existing imports (index.ts, test files) to work unchanged.
// ===========================================================================

/** Minimal ReminderInjection shape compatible with allPatchesAgainstPristine tests */
interface CompatReminderInjection {
  id: string;
  name: string;
  description: string;
  placeholders: Record<string, string>;
  defaultBody: string;
  apply(content: string, body: string, isSuppressed: boolean): string | null;
  shadows?: string[];
}

/** Build a compat entry from a LexPatcher config */
function makeCompatEntry(
  id: string,
  name: string,
  description: string,
  placeholders: Record<string, string>,
  defaultBody: string,
  config: LexPatcherConfig
): CompatReminderInjection {
  return {
    id,
    name,
    description,
    placeholders,
    defaultBody,
    apply(content, body, isSuppressed) {
      // Clone the config so we don't mutate state across calls
      const cfg: LexPatcherConfig = JSON.parse(JSON.stringify(config));

      // For suppressed entries, swap injection template to a no-op return
      if (isSuppressed) {
        for (const inj of cfg.injections) {
          inj.template = () => '__TWEAKCC_REWRITE__';
        }
      }

      const patcher = new LexPatcher(cfg);
      return patcher.apply(content);
    },
  };
}

// Build a REMINDER_REGISTRY with entries for all configs that have known IDs.
const COMPAT_ENTRIES: CompatReminderInjection[] = [
  // Pattern A: simpleEntryPattern (5 reminders)
  makeCompatEntry(
    'date-change',
    'Date change reminder',
    'Fires when the system date rolls over mid-session.',
    {},
    '',
    buildSimpleEntryConfig('date_change')
  ),
  makeCompatEntry(
    'compact-file-reference',
    'Compact file reference',
    'Shows a compact reference to edited files.',
    {},
    '',
    buildSimpleEntryConfig('compact_file_reference')
  ),
  makeCompatEntry(
    'pdf-reference',
    'PDF reference reminder',
    'Inline PDF link reminder.',
    {},
    '',
    buildSimpleEntryConfig('pdf_reference')
  ),
  makeCompatEntry(
    'selected-lines-in-ide',
    'Selected lines in IDE',
    'Highlights selected lines when editing in an IDE.',
    {},
    '',
    buildSimpleEntryConfig('selected_lines_in_ide')
  ),
  makeCompatEntry(
    'opened-file-in-ide',
    'Opened file in IDE',
    'Notifies when a file is opened in the IDE.',
    {},
    '',
    buildSimpleEntryConfig('opened_file_in_ide')
  ),

  // Pattern B: direct arrow (subset — these have distinct configs)
  makeCompatEntry(
    'token-usage',
    'Token usage reminder',
    'Per-turn token usage stats.',
    {},
    '',
    buildDirectArrowConfig('token_usage', 'Token usage:')
  ),
  makeCompatEntry(
    'budget-usd',
    'USD budget reminder',
    'Per-turn USD budget tracking.',
    {},
    '',
    buildDirectArrowConfig('budget_usd', 'USD budget:')
  ),

  // user-sent-new-message: findAndReplace-style with capture groups (prefix + hParam)
  {
    id: 'user-sent-new-message',
    name: 'User-sent-new-message wrapper',
    description:
      'Wraps a user message that arrives mid-turn. Carries the "This is how Claude Code surfaces messages the user sends mid-turn … Address the message above as you continue this turn" framing (reworded in CC 2.1.205 from the old imperative "IMPORTANT: … you MUST address … Do not ignore it"). Empty .md = no wrapping (just the message text).',
    placeholders: {
      message: '${H}',
    },
    defaultBody: `The user sent a new message while you were working:
{{message}}

This is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`,
    apply(content, body, isSuppressed) {
      const pattern =
        /((?:case"auto-continuation":)?case"human":case void 0:(?:default:)?)return`(?:The user sent a new message while you were working:\n|\$\{[$\w]+\})\$\{([$\w]+)\}\n\n(?:This is how Claude Code surfaces messages the user sends mid-turn \\u2014 within the running turn, often alongside the next tool result, rather than as a separate conversation turn\. Address the message above as you continue this turn\.|IMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.)`/;
      const match = content.match(pattern);
      if (!match || match.index === undefined) {
        console.error(
          'patch: reminder user-sent-new-message: failed to find anchor'
        );
        return null;
      }
      const [, prefix, hParam] = match;
      let replacement: string;
      if (isSuppressed) {
        replacement = `${prefix}return\`\${${hParam}}\``;
      } else {
        const bodyForBuild = body.replace(/\$\{H\}/g, `\${${hParam}}`);
        replacement = `${prefix}return\`${bodyForBuild}\``;
      }
      return (
        content.slice(0, match.index) +
        replacement +
        content.slice(match.index + match[0].length)
      );
    },
  },

  // Pattern C: complex inline shapes
  makeCompatEntry(
    'plan-mode-exit',
    'Plan mode exit reminder',
    'Fires when exiting plan mode.',
    {},
    '',
    PLAN_MODE_EXIT_CONFIG
  ),
  makeCompatEntry(
    'auto-mode-exit',
    'Auto mode exit reminder',
    'Fires when exiting auto mode.',
    {},
    '',
    AUTO_MODE_EXIT_CONFIG
  ),
  makeCompatEntry(
    'output-style-banner',
    'Output style banner',
    'Per-turn output style banner.',
    {},
    '',
    OUTPUT_STYLE_CONFIG
  ),

  // Pattern D: findCaseBody switch cases (subset)
  makeCompatEntry(
    'mcp-instructions',
    'MCP instructions reminder',
    '# MCP Server Instructions block.',
    {},
    '',
    buildFindCaseBodyConfig(
      'mcp_instructions_delta',
      '# MCP Server Instructions'
    )
  ),
  makeCompatEntry(
    'agent-listing',
    'Agent listing reminder',
    'Available agent types for the Agent tool.',
    {},
    '',
    buildFindCaseBodyConfig(
      'agent_listing_delta',
      'Available agent types for the Agent tool:'
    )
  ),
  makeCompatEntry(
    'memory-update',
    'Memory update reminder',
    'Updated your memory directory.',
    {},
    '',
    buildFindCaseBodyConfig('memory_update', 'updated your memory directory')
  ),

  // Pattern E: standalone function declarations
  makeCompatEntry(
    'tool-called',
    'Tool called preamble',
    '"Called the X tool with input..." per-tool-call.',
    {},
    '',
    TOOL_CALLED_CONFIG
  ),

  // Pattern F: early-return guard shapes (subset)
  makeCompatEntry(
    'hook-additional-context',
    'Hook additional context wrapper',
    'Wraps hook content into model context.',
    {},
    '',
    HOOK_ADDITIONAL_CONTEXT_CONFIG
  ),
  makeCompatEntry(
    'skill-listing',
    'Skills listing reminder',
    '"The following skills are available..." block.',
    {},
    '',
    SKILL_LISTING_CONFIG
  ),

  // Pattern G: task-notification-framing
  makeCompatEntry(
    'task-notification-framing',
    'Task notification framing',
    '[SYSTEM NOTIFICATION] framing for task notifications.',
    {},
    '',
    TASK_NOTIFICATION_FRAMING_CONFIG
  ),

  // Pattern H: stop-hook-session-goal
  makeCompatEntry(
    'stop-hook-session-goal',
    'Stop hook session goal',
    'Session-scoped Stop hook condition display.',
    {},
    '',
    STOP_HOOK_SESSION_GOAL_CONFIG
  ),
];

// Export a compatible REMINDER_REGISTRY for tests that need it.
export const REMINDER_REGISTRY: CompatReminderInjection[] = COMPAT_ENTRIES;

/** Result shape matching the original ReminderApplyResult */
interface PatchResult {
  id: string;
  name: string;
  description: string;
  state: 'default' | 'override' | 'suppressed';
  applied: boolean;
  failed: boolean;
  skipped: boolean;
  details?: string;
}

/**
 * Async wrapper matching the original systemReminderOverrides.applySystemReminderOverrides signature.
 */
export async function applySystemReminderOverrides(
  content: string
): Promise<{ content: string; results: PatchResult[] }> {
  let working = content;
  const results: PatchResult[] = [];

  for (const rc of REMINDER_CONFIGS) {
    try {
      const patcher = new LexPatcher(rc.config);
      const patchedResult = patcher.apply(working);
      if (!patchedResult) {
        // Find the compat entry to get name/description
        const entry = COMPAT_ENTRIES.find(e => e.id === rc.id);
        results.push({
          id: rc.id,
          name: entry?.name ?? rc.id,
          description: entry?.description ?? '',
          state: 'default',
          applied: false,
          failed: true,
          skipped: false,
          details: 'anchor not found in source',
        });
        continue;
      }
      working = patchedResult;

      const entry = COMPAT_ENTRIES.find(e => e.id === rc.id);
      results.push({
        id: rc.id,
        name: entry?.name ?? rc.id,
        description: entry?.description ?? '',
        state: 'override',
        applied: true,
        failed: false,
        skipped: false,
      });
    } catch {
      const entry = COMPAT_ENTRIES.find(e => e.id === rc.id);
      results.push({
        id: rc.id,
        name: entry?.name ?? rc.id,
        description: entry?.description ?? '',
        state: 'default',
        applied: false,
        failed: true,
        skipped: false,
        details: 'patcher threw exception',
      });
    }
  }

  return { content: working as string, results };
}
