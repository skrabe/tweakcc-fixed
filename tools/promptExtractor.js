#!/usr/bin/env node

const fs = require('fs');
const parser = require('@babel/parser');

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Shared identifierMap for the 10 bundled workflow scripts (2.1.146). Every
// `export const meta = {...}` block interpolates the same 5 slots in order:
// name, description, whenToUse, then the `${JSON.stringify(phases)}` pair.
const WORKFLOW_SCRIPT_IDENTIFIER_MAP = {
  0: 'WORKFLOW_NAME',
  1: 'WORKFLOW_DESCRIPTION',
  2: 'WORKFLOW_WHEN_TO_USE',
  3: 'JSON',
  4: 'WORKFLOW_PHASES',
};

// Manual ID/name assignments for prompts that are NEW in a CC version (not
// in the seed JSON, so the fuzzy matcher can't carry over a name from the
// previous version). Each entry's `matcher` runs against the reconstructed
// content; first match wins. Used for both inclusion (validateInput) and
// naming (mergeWithExisting fallback). The optional `identifierMap` provides
// semantic names for the prompt's interpolated identifiers — required when
// override .md files reference those names (`${ATTACHMENT_OBJECT.filename}`).
const NEW_PROMPT_ASSIGNMENTS = [
  // 2.1.170 — four-zeros fix: three code-review prompts carried partial
  // identifierMaps (slot named only where the 4.8 overrides used it), so their
  // pristine stubs rendered ${UNKNOWN_N}. Surfaced when the Fable-5 pass left
  // these files pristine. Piebald doesn't catalogue these fragments, so the
  // names are ours: P6q = the 3-state vote definitions block, W6q = the
  // PLAUSIBLE-by-default recall rubric, Z6q = the commonly-missed-defects list.
  {
    matcher: t => t.includes('and have it return exactly one of:'),
    name: 'Skill: Code Review (Phase 2 — verify, 3-state)',
    id: 'skill-code-review-phase-2-verify-3-state',
    description:
      'Phase 2 of the code-review skill for precision tiers — one verifier per candidate, 3-state CONFIRMED/PLAUSIBLE/REFUTED vote',
    identifierMap: {
      '0': 'AGENT_TOOL_NAME',
      '1': 'VERIFY_VOTE_DEFINITIONS',
    },
  },
  {
    matcher: t =>
      t.includes('it returns exactly') &&
      t.includes('one of **CONFIRMED / PLAUSIBLE / REFUTED**'),
    name: 'Skill: Code Review (Phase 2 — verify, recall-biased)',
    id: 'skill-code-review-phase-2-verify-recall-biased',
    description:
      'Phase 2 of the code-review skill for recall tiers — one verifier per candidate, recall-biased keep rule',
    identifierMap: {
      '0': 'AGENT_TOOL_NAME',
      '1': 'RECALL_BIASED_RUBRIC',
    },
  },
  {
    matcher: t => t.includes('what the first pass tends to miss:'),
    name: 'Skill: Code Review (Phase 3 — sweep for gaps)',
    id: 'skill-code-review-phase-3-sweep',
    description:
      'Shared Phase 3 of the code-review skill — a fresh finder re-reads the diff for defects not already listed',
    identifierMap: {
      '0': 'SWEEP_MISS_CATEGORIES',
    },
  },
  // 2.1.169
  {
    // 2.1.169 grew the /schedule prompt from 15 interpolation sites to 34, which
    // dropped it below the fuzzy-match threshold so it extracts anonymous and the
    // opus-4-8/4-7 override stops binding. The 34 sites still dedupe to the SAME
    // 15 underlying identifiers (identifierMap is keyed by unique-identifier index
    // 0–14, not by site), and every index keeps its .168 first-appearance order
    // and meaning (0 one-off gate … 7 NEW_ENVIRONMENT_OBJECT with .name/.environment_id
    // … 8 USER_TIMEZONE … 14 USER_REQUEST at the closing "The user said:"). So the
    // .168 identifierMap carries over verbatim — the override's ${VAR}s re-bind 1:1.
    matcher: t =>
      t.includes('# Schedule Cloud Agents') &&
      t.includes('each routine spawns a fully isolated cloud session'),
    name: 'Agent Prompt: /schedule slash command',
    id: 'agent-prompt-schedule-slash-command',
    description:
      'Guides the user through scheduling, updating, listing, or running remote Claude Code agents on cron triggers via the Anthropic cloud API',
    identifierMap: {
      '0': 'ONE_OFF_ENABLED_FN',
      '1': 'ASK_USER_QUESTION_TOOL_NAME',
      '2': 'ADDITIONAL_INFO_BLOCK',
      '3': 'REMOTE_TRIGGER_TOOL_NAME',
      '4': 'DEFAULT_GIT_REPO_URL',
      '5': 'MCP_CONNECTORS_LIST',
      '6': 'ENVIRONMENTS_LIST',
      '7': 'NEW_ENVIRONMENT_OBJECT',
      '8': 'USER_TIMEZONE',
      '9': 'NOW_LOCAL_TIME',
      '10': 'NOW_UTC_ISO',
      '11': 'IS_GITHUB_REMINDER_ENABLED',
      '12': 'IS_TRUTHY_FN',
      '13': 'CHECK_FEATURE_FLAG_FN',
      '14': 'USER_REQUEST',
    },
  },
  {
    // 2.1.169 restructured "Communicating with the user" enough to drop below
    // the fuzzy-match threshold (it gained a `${cond?…:…}` conditional opener),
    // so it extracts anonymous and its opus-4-8 override stops binding. Re-pin
    // the .168 id/name. The override is a static full replacement (no `${VAR}`),
    // so no identifierMap is needed.
    matcher: t =>
      t.includes('# Communicating with the user') &&
      t.includes('Write it for a teammate who stepped away'),
    name: 'System Prompt: Communicating with the user',
    id: 'system-prompt-communicating-with-the-user',
    description:
      'System-prompt section on writing user-facing text between tool calls (the reader usually cannot see thinking or raw tool results)',
  },
  {
    // 2.1.169 reworked the bundled design-sync package source adapter (the
    // non-Storybook `package` adapter); content moved past the rename threshold
    // so it extracts anonymous. Re-pin the .168 id/name. Executable adapter
    // source, no interpolation slots.
    matcher: t =>
      t.includes('Non-storybook') &&
      t.includes('adapter. Bundles dist/ when present'),
    name: 'Skill: /design-sync package source adapter',
    id: 'skill-design-sync-package-source-adapter',
    description:
      'Bundled lib/source-kit.mjs adapter for the design-sync skill: the non-Storybook package source adapter that bundles dist/ and enriches components from shipped .d.ts',
  },
  {
    // New in 2.1.169: the /code-review "Efficiency" review dimension (cL section
    // listing wasted-work signals). Net-new section, no override yet.
    matcher: t =>
      t.includes('### Efficiency') &&
      t.includes('Flag wasted work the diff introduces'),
    name: 'Skill: /code-review efficiency dimension',
    id: 'skill-code-review-efficiency',
    description:
      'Code-review dimension: flag wasted work the diff introduces (redundant computation/IO, needless sequential work, closures that retain large scopes) and name the cheaper alternative',
  },
  {
    // New in 2.1.169: EnterWorktree isolation directive — instructs the agent to
    // call EnterWorktree before its first edit unless already isolated. Net-new
    // system-prompt fragment paired with the EnterWorktree/ExitWorktree tools.
    matcher: t =>
      t.includes('use the EnterWorktree tool to isolate your work'),
    name: 'System Prompt: EnterWorktree isolation directive',
    id: 'system-prompt-enter-worktree-isolation-directive',
    description:
      "Directs the agent to call EnterWorktree before its first edit to isolate work from parallel jobs and the user's working copy, unless the cwd is already under .claude/worktrees/",
  },
  {
    // New in 2.1.169: "operating autonomously" directive — the AFK-mode guidance
    // that suppresses permission-seeking and requires finishing promised work
    // before ending the turn. Distinct from the autonomous-loop-tick prompts.
    matcher: t =>
      t.includes(
        'You are operating autonomously. The user is not watching in real time'
      ),
    name: 'System Prompt: Operating autonomously',
    id: 'system-prompt-operating-autonomously',
    description:
      'Autonomous-mode directive: proceed on reversible actions without asking, stop only for destructive actions or genuine scope changes, and finish any promised work before ending the turn',
  },
  // 2.1.168
  {
    // croncreate's carried-over identifierMap was partial: 3 of 7 slots named,
    // frozen at 2.1.144 before Anthropic grew the prompt to 7 interpolations
    // (durability section, monitor-enabled gate, MONITOR_TOOL_NAME, durable
    // runtime note). The 4 unnamed slots shifted the carried labels, so the
    // override's ${CANCEL_TIMEFRAME_DAYS} bound to the IS_MONITOR_TOOL_ENABLED
    // function instead of the day-count value and rendered function source into
    // the tool description (boots, so four-zeros + smoke missed it). Overlay the
    // full 7-slot map — matches Piebald's canonical naming; the identifiers
    // array is byte-identical, so the names drop straight onto our slots.
    matcher: t =>
      t.includes('Schedule a prompt to be enqueued at a future time'),
    name: 'Tool Description: CronCreate',
    id: 'tool-description-croncreate',
    description:
      'Describes the CronCreate tool for enqueuing one-shot or recurring cron-based jobs with jitter and off-minute scheduling guidance',
    identifierMap: {
      '0': 'CRON_DURABILITY_SECTION',
      '1': 'IS_MONITOR_TOOL_ENABLED_FN',
      '2': 'CRON_CREATE_TOOL_NAME',
      '3': 'MONITOR_TOOL_NAME',
      '4': 'CRON_DURABLE_RUNTIME_NOTE',
      '5': 'CANCEL_TIMEFRAME_DAYS',
      '6': 'CRON_DELETE_TOOL_NAME',
    },
  },
  // 2.1.167
  {
    // New in 2.1.167: cross-session peer-message authority disclaimer (d_q).
    // uIK() wraps a relayed peer message as
    // `${Jy6}\n${msg}\n\n${d_q}${dbK}` — Jy6 "Another Claude session sent a
    // message[ while you were working]:" + body + this disclaimer (+ dbK
    // follow-up). Matches Piebald's canonical id for the same string.
    matcher: t =>
      t.includes(
        'relaying denied actions between sessions is permission laundering'
      ),
    name: 'System Reminder: Cross-session peer message authority warning',
    id: 'system-reminder-cross-session-peer-message-authority-warning',
    description:
      'Warns that an incoming message from another Claude session is not user authority, cannot grant consent, and must not be used for permission laundering',
  },
  {
    // New in 2.1.167: bundled storybook/probe.mjs (cL4) for the design-sync
    // skill — net-new vs Piebald, analogous to the
    // skill-design-sync-*-source-adapter bundled-code prompts. The 2.1.165
    // monolithic lib/source-storybook.mjs was decomposed into
    // storybook/{http-serve,probe,build,emit,validate}.mjs; this is the probe
    // that visits the repo's own _sb/iframe.html in headless chromium.
    matcher: t => t.includes('One chromium page visit against'),
    name: 'Skill: /design-sync Storybook probe',
    id: 'skill-design-sync-storybook-probe',
    description:
      "Bundled storybook/probe.mjs for the design-sync skill: visits the repo's own _sb/iframe.html in headless chromium to extract argTypes (prop tables) and fiber-walk provider detection",
  },
  // 2.1.165
  {
    // Fuzzy-carryover miss: the $TMPDIR tool-description's opening was reworded
    // ("set to the same sandbox-writable directory for both sandboxed and
    // unsandboxed commands" -> "automatically set to the correct
    // sandbox-writable directory in sandbox mode"), changing the 100-char fuzzy
    // fingerprint so the name dropped. Same prompt -> same id.
    matcher: t =>
      t.includes(
        'TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode'
      ),
    name: 'Tool Description: Bash (sandbox — tmpdir)',
    id: 'tool-description-bash-sandbox-tmpdir',
    description: 'Use $TMPDIR for temporary files in sandbox mode',
  },
  {
    // New system-prompt section in 2.1.165 (returned by tg3(), injected into the
    // assembled system prompt alongside the security-testing guidance).
    matcher: t =>
      t.startsWith(
        '# Communicating with the user\n\nYour text output is what the user reads'
      ),
    name: 'System Prompt: Communicating with the user',
    id: 'system-prompt-communicating-with-the-user',
    description:
      'System-prompt section on writing user-facing text between tool calls (the reader usually cannot see thinking or raw tool results)',
  },
  {
    // New "Cowork Plugin Authoring" skill (SKILL.md = jG4); bundles four
    // reference docs under references/ (the four entries below).
    matcher: t => t.startsWith('# Cowork Plugin Authoring'),
    name: 'Skill: Cowork Plugin Authoring',
    id: 'skill-cowork-plugin-authoring',
    description:
      'Skill for creating a new Cowork plugin from scratch or customizing an existing one for an organization, delivering an installable .plugin file',
  },
  {
    // references/component-schemas.md (KG4) bundled by the Cowork skill.
    matcher: t =>
      t.startsWith(
        '# Component Schemas\n\nDetailed format specifications for every plugin component'
      ),
    name: 'Skill: Cowork Plugin Authoring — Component Schemas',
    id: 'skill-cowork-plugin-authoring-component-schemas',
    description:
      'Cowork plugin-authoring reference: format specifications for every plugin component type (skills, commands, agents, MCP, hooks)',
  },
  {
    // references/example-plugins.md (TG4).
    matcher: t =>
      t.startsWith('# Example Plugins\n\nThree complete plugin structures'),
    name: 'Skill: Cowork Plugin Authoring — Example Plugins',
    id: 'skill-cowork-plugin-authoring-example-plugins',
    description:
      'Cowork plugin-authoring reference: three complete example plugin structures (minimal to complex) used as implementation templates',
  },
  {
    // references/mcp-servers.md (zG4).
    matcher: t => t.startsWith('# MCP Discovery and Connection'),
    name: 'Skill: Cowork Plugin Authoring — MCP Discovery and Connection',
    id: 'skill-cowork-plugin-authoring-mcp-discovery',
    description:
      'Cowork plugin-authoring reference: how to find and connect MCP servers during plugin customization (search_mcp_registry et al.)',
  },
  {
    // references/search-strategies.md (YG4).
    matcher: t => t.startsWith('# Knowledge MCP Search Strategies'),
    name: 'Skill: Cowork Plugin Authoring — Knowledge MCP Search Strategies',
    id: 'skill-cowork-plugin-authoring-search-strategies',
    description:
      'Cowork plugin-authoring reference: query patterns for gathering organizational context from a Knowledge MCP during plugin customization',
  },
  {
    // shared/token-counting.md (Ak4) bundled by the Build-with-Claude-API skill.
    // In 2.1.162 "# Token Counting" only existed as a section inside the
    // per-language API reference docs; 2.1.165 promoted it to a shared doc.
    matcher: t => t.startsWith('# Token Counting\n\nUse the '),
    name: 'Data: Token counting',
    id: 'data-token-counting',
    description:
      'Shared Build-with-Claude-API reference: using the count_tokens endpoint for accurate, model-specific token counts',
  },
  // 2.1.162
  {
    // NotebookEdit description rewritten in 2.1.162 (was "Completely replaces
    // the contents of a specific cell..."; now supports insert/delete and
    // gained a ${Read} tool-name slot). Same tool/prompt -> same id; the
    // rewrite changed the fuzzy fingerprint so carryover dropped the name.
    matcher: t =>
      t.includes(
        'Replaces, inserts, or deletes a single cell in a Jupyter notebook'
      ),
    name: 'Tool Description: NotebookEdit',
    id: 'tool-description-notebookedit',
    description:
      'Describes the NotebookEdit tool for replacing, inserting, or deleting a single cell in a Jupyter notebook (.ipynb)',
    identifierMap: { '0': 'READ_TOOL_NAME' },
  },
  {
    matcher: t =>
      t.includes('# Package source shape\n\nNo Storybook — the component list'),
    name: 'Skill: /design-sync package source shape',
    id: 'skill-design-sync-package-source-shape',
    description:
      'design-sync skill reference shown when no Storybook is present: the component list comes from the package’s shipped .d.ts exports and previews are generated from .d.ts prop types',
  },
  {
    matcher: t => t.includes('# Storybook source shape\n\n'),
    name: 'Skill: /design-sync Storybook source shape',
    id: 'skill-design-sync-storybook-source-shape',
    description:
      'design-sync skill reference shown when .storybook/ is found: the component list and story args come from storybook-static/index.json',
  },
  {
    // Bundled .mjs adapter source (lib/source-kit.mjs) — net-new vs Piebald,
    // analogous to the workflow-script-* bundled-code prompts.
    matcher: t => t.includes('Always bundles dist/ (the authoritative'),
    name: 'Skill: /design-sync package source adapter',
    id: 'skill-design-sync-package-source-adapter',
    description:
      'Bundled lib/source-kit.mjs adapter for the design-sync skill: the non-Storybook package source adapter that bundles dist/ and enriches components from shipped .d.ts',
  },
  {
    // Bundled .mjs adapter source (lib/source-storybook.mjs).
    matcher: t =>
      t.includes(
        '// Storybook source adapter. Builds (or copies) storybook-static'
      ),
    name: 'Skill: /design-sync Storybook source adapter',
    id: 'skill-design-sync-storybook-source-adapter',
    description:
      'Bundled lib/source-storybook.mjs adapter for the design-sync skill: builds storybook-static, parses index.json, and runs composeStories to extract story args',
  },
  // 2.1.142
  {
    matcher: t => t.includes('Generate a short kebab-case name (2-4 words)'),
    name: 'Agent Prompt: /rename auto-generate session name',
    id: 'agent-prompt-rename-auto-generate-session-name',
    description: 'Prompt used by /rename (no args) to auto-generate a kebab-case session name from conversation context',
  },
  {
    matcher: t => t.includes('Send files to the user. Use this when the file *is* the deliverable'),
    name: 'Tool Description: SendUserFile',
    id: 'tool-description-senduserfile',
    description: 'Describes the SendUserFile tool for surfacing generated deliverable files to the user, with optional captions and normal or proactive status',
  },
  {
    matcher: t => t.includes('verifier skills that can be used by the Verify agent'),
    name: 'Skill: Create verifier skills',
    id: 'skill-create-verifier-skills',
    description: 'Prompt for creating verifier skills for the Verify agent to automatically verify code changes',
    identifierMap: { '0': 'ENABLE_TASKS_FEATURE', '1': 'TASKCREATE_TOOL_NAME', '2': 'TODOWRITE_TOOL_NAME' },
  },
  {
    matcher: t => t.includes('was read before the last conversation was summarized'),
    name: 'System Reminder: Compact file reference',
    id: 'system-reminder-compact-file-reference',
    description: 'Reference to file read before conversation summarization',
    identifierMap: { '0': 'ATTACHMENT_OBJECT', '1': 'READ_TOOL_OBJECT' },
  },
  {
    matcher: t => t.includes('other modified files in this turn already exceeded the snippet budget'),
    name: 'System Reminder: File modification detected (budget exceeded)',
    id: 'system-reminder-file-modification-detected-budget-exceeded',
    description: 'System reminder for when a file modification is detected - specifically when other modified files in the turn already exceeded the budget.',
    identifierMap: { '0': 'FILE_OBJECT' },
  },
  {
    matcher: t => t.includes('Here are the relevant changes (shown with line numbers):'),
    name: 'System Reminder: File modified by user or linter',
    id: 'system-reminder-file-modified-externally',
    description: 'Notification that a file was modified externally',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => t.includes('was too large and has been truncated to the first'),
    name: 'System Reminder: File truncated',
    id: 'system-reminder-file-truncated',
    description: 'Notification that file was truncated due to size',
    identifierMap: { '0': 'ATTACHMENT_OBJECT', '1': 'MAX_LINES_CONSTANT', '2': 'READ_TOOL_OBJECT' },
  },
  {
    matcher: t => /^\$\{[^}]+\} hook additional context: /.test(t),
    name: 'System Reminder: Hook additional context',
    id: 'system-reminder-hook-additional-context',
    description: 'Additional context from a hook',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => /^\$\{[^}]+\} hook blocking error from command:/.test(t),
    name: 'System Reminder: Hook blocking error',
    id: 'system-reminder-hook-blocking-error',
    description: 'Error from a blocking hook command',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => /^\$\{[^}]+\} hook success: \$\{/.test(t),
    name: 'System Reminder: Hook success',
    id: 'system-reminder-hook-success',
    description: 'Success message from a hook',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => t.includes('(No content)</mcp-resource>'),
    name: 'System Reminder: MCP resource no content',
    id: 'system-reminder-mcp-resource-no-content',
    description: 'Shown when MCP resource has no content',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => t.includes('(No displayable content)</mcp-resource>'),
    name: 'System Reminder: MCP resource no displayable content',
    id: 'system-reminder-mcp-resource-no-displayable-content',
    description: 'Shown when MCP resource has no displayable content',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => t.includes('output style is active'),
    name: 'System Reminder: Output style active',
    id: 'system-reminder-output-style-active',
    description: 'Notification that an output style is active',
    identifierMap: { '0': 'OUTPUT_STYLE_CONFIG', '1': 'OUTPUT_STYLE_TURN_REMINDER' },
  },
  {
    matcher: t => t.startsWith('Token usage: ${'),
    name: 'System Reminder: Token usage',
    id: 'system-reminder-token-usage',
    description: 'Current token usage statistics',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    matcher: t => t.startsWith('USD budget: $${'),
    name: 'System Reminder: USD budget',
    id: 'system-reminder-usd-budget',
    description: 'Current USD budget statistics',
    identifierMap: { '0': 'ATTACHMENT_OBJECT' },
  },
  {
    // cli.js has `it’s` (curly apostrophe escape) so match what's stable.
    matcher: t => t.includes('better to use the built-in tools as they provide a better'),
    name: 'Tool Description: Bash (built-in tools note)',
    id: 'tool-description-bash-built-in-tools-note',
    description: 'Note that built-in tools provide better UX than Bash equivalents',
    identifierMap: { '0': 'BASH_TOOL_NAME' },
  },
  // 2.1.144
  {
    matcher: t => t.startsWith('## Durability\n\nBy default (durable: false) the job lives only in this Claude session'),
    name: 'Tool Description: CronCreate (durability note)',
    id: 'tool-description-croncreate-durability',
    description: 'Sub-prompt explaining the durable: true / false trade-off, inserted into CronCreate when the durable-cron feature flag is on',
  },
  // 2.1.148 — the /code-review skill was restructured from one prompt
  // (skill-code-review) into 11 composable fragments. The skill (tK4)
  // assembles the prompt at invocation time: xYO={low,medium,high,xhigh,max}
  // selects an effort-tier prompt, which interpolates the shared phase /
  // angle / output sub-fragments; the --comment GitHub section is appended
  // when the flag is passed.
  {
    matcher: t => t.includes('## Posting to GitHub (--comment)'),
    name: 'Skill: Code Review (--comment GitHub posting)',
    id: 'skill-code-review-posting-to-github',
    description: 'Appended to the code-review prompt when --comment is passed; instructs posting each finding as an inline PR comment',
  },
  // 2.1.151+ shape: effort-tier prompts gained 5 per-angle fragment slots
  // (g4q/Q4q/d4q/c4q/l4q = Reuse/Simplification/Efficiency/Altitude/Cleanup-note
  // plus zD4 or HEO for the verify phase). The header line gained a "+N angles"
  // suffix that uniquely identifies the new shape: medium/high → "3+4 angles",
  // max/xhigh → "5+4 angles". These 2.1.151+ entries land first so they win
  // over the 2.1.148-shape fallbacks below.
  {
    matcher: t =>
      t.includes('5+4 angles') && t.includes('"maximum":"extra-high"'),
    name: 'Skill: Code Review (max / xhigh effort)',
    id: 'skill-code-review-effort-max',
    description: 'Effort-tier prompt for max and xhigh code review — 5+4 angles, up to 8 candidates, recall-biased, sweep + 3-state verify, up to 15 findings',
    identifierMap: {
      0: 'EFFORT_LEVEL',
      1: 'PHASE_0_GATHER_DIFF',
      2: 'AGENT_TOOL_NAME',
      3: 'HIGH_EFFORT_ANGLES_INTRO',
      4: 'ANGLE_REUSE',
      5: 'ANGLE_SIMPLIFICATION',
      6: 'ANGLE_EFFICIENCY',
      7: 'ANGLE_ALTITUDE',
      8: 'CLEANUP_CANDIDATES_NOTE',
      9: 'PHASE_2_VERIFY_3_STATE',
      10: 'PHASE_3_SWEEP',
      11: 'OUTPUT_FORMAT_FN',
    },
  },
  {
    matcher: t =>
      t.includes('3+4 angles') && t.includes('catch every real bug a careful'),
    name: 'Skill: Code Review (high effort)',
    id: 'skill-code-review-effort-high',
    description: 'Effort-tier prompt for high code review — 3+4 angles, up to 6 candidates, recall-biased verify, up to 10 findings',
    identifierMap: {
      0: 'PHASE_0_GATHER_DIFF',
      1: 'AGENT_TOOL_NAME',
      2: 'ANGLES_LINE_BY_LINE',
      3: 'ANGLE_REUSE',
      4: 'ANGLE_SIMPLIFICATION',
      5: 'ANGLE_EFFICIENCY',
      6: 'ANGLE_ALTITUDE',
      7: 'CLEANUP_CANDIDATES_NOTE',
      8: 'PHASE_2_VERIFY_RECALL_BIASED',
      9: 'OUTPUT_FORMAT_FN',
    },
  },
  {
    matcher: t =>
      t.includes('3+4 angles') && t.includes('at medium effort: every finding you surface'),
    name: 'Skill: Code Review (medium effort)',
    id: 'skill-code-review-effort-medium',
    description: 'Effort-tier prompt for medium code review — 3+4 angles, up to 6 candidates, precision-biased 3-state verify, up to 8 findings',
    identifierMap: {
      0: 'PHASE_0_GATHER_DIFF',
      1: 'AGENT_TOOL_NAME',
      2: 'ANGLES_LINE_BY_LINE',
      3: 'ANGLE_REUSE',
      4: 'ANGLE_SIMPLIFICATION',
      5: 'ANGLE_EFFICIENCY',
      6: 'ANGLE_ALTITUDE',
      7: 'CLEANUP_CANDIDATES_NOTE',
      8: 'PHASE_2_VERIFY_3_STATE',
      9: 'OUTPUT_FORMAT_FN',
    },
  },

  // 2.1.148 shape (pre-restructure): kept as fallbacks for older binaries.
  {
    matcher: t => t.includes('"maximum":"extra-high"} effort: catch'),
    name: 'Skill: Code Review (max / xhigh effort)',
    id: 'skill-code-review-effort-max',
    description: 'Effort-tier prompt for max and xhigh code review — 5 angles, up to 8 candidates, recall-biased, up to 15 findings',
    identifierMap: {
      0: 'EFFORT_LEVEL',
      1: 'PHASE_0_GATHER_DIFF',
      2: 'AGENT_TOOL_NAME',
      3: 'HIGH_EFFORT_ANGLES',
      4: 'PHASE_2_VERIFY_3_STATE',
      5: 'PHASE_3_SWEEP',
      6: 'OUTPUT_FORMAT_FN',
    },
  },
  {
    matcher: t => t.includes('catch every real bug a careful'),
    name: 'Skill: Code Review (high effort)',
    id: 'skill-code-review-effort-high',
    description: 'Effort-tier prompt for high code review — 3 angles, up to 6 candidates, recall-biased, up to 10 findings',
    identifierMap: {
      0: 'PHASE_0_GATHER_DIFF',
      1: 'AGENT_TOOL_NAME',
      2: 'ANGLES_LINE_BY_LINE',
      3: 'PHASE_2_VERIFY_RECALL_BIASED',
      4: 'OUTPUT_FORMAT_FN',
    },
  },
  {
    matcher: t => t.includes('at medium effort: every finding you surface'),
    name: 'Skill: Code Review (medium effort)',
    id: 'skill-code-review-effort-medium',
    description: 'Effort-tier prompt for medium code review — 3 angles, up to 6 candidates, precision-biased, up to 8 findings',
    identifierMap: {
      0: 'PHASE_0_GATHER_DIFF',
      1: 'AGENT_TOOL_NAME',
      2: 'ANGLES_LINE_BY_LINE',
      3: 'PHASE_2_VERIFY_3_STATE',
      4: 'OUTPUT_FORMAT_FN',
    },
  },
  {
    matcher: t => t.includes('1 diff pass '),
    name: 'Skill: Code Review (low effort)',
    id: 'skill-code-review-effort-low',
    description: 'Effort-tier prompt for low code review — single diff pass, no verify, up to 4 findings',
  },
  {
    matcher: t => t.includes('Return findings as a JSON array of at most'),
    name: 'Skill: Code Review (findings JSON output)',
    id: 'skill-code-review-output-format',
    description: 'Shared output spec for the code-review skill — findings as a JSON array with file/line/summary/failure_scenario',
    identifierMap: { 0: 'MAX_FINDINGS' },
  },
  {
    matcher: t => t.includes('Gather the diff'),
    name: 'Skill: Code Review (Phase 0 — gather the diff)',
    id: 'skill-code-review-phase-0-gather-diff',
    description: 'Shared Phase 0 of the code-review skill — gather the unified diff under review via git diff',
  },
  {
    matcher: t => t.includes('Verify (1-vote, 3-state)'),
    name: 'Skill: Code Review (Phase 2 — verify, 3-state)',
    id: 'skill-code-review-phase-2-verify-3-state',
    description: 'Phase 2 of the code-review skill for precision tiers — one verifier per candidate, 3-state CONFIRMED/PLAUSIBLE/REFUTED vote',
    identifierMap: { 0: 'AGENT_TOOL_NAME' },
  },
  {
    matcher: t => t.includes('Verify (1-vote, recall-biased)'),
    name: 'Skill: Code Review (Phase 2 — verify, recall-biased)',
    id: 'skill-code-review-phase-2-verify-recall-biased',
    description: 'Phase 2 of the code-review skill for recall tiers — one verifier per candidate, recall-biased keep rule',
    identifierMap: { 0: 'AGENT_TOOL_NAME' },
  },
  {
    matcher: t => t.includes('Sweep for gaps'),
    name: 'Skill: Code Review (Phase 3 — sweep for gaps)',
    id: 'skill-code-review-phase-3-sweep',
    description: 'Shared Phase 3 of the code-review skill — a fresh finder re-reads the diff for defects not already listed',
  },
  {
    matcher: t => t.includes('line-by-line diff scan'),
    name: 'Skill: Code Review (Angle A — line-by-line diff scan)',
    id: 'skill-code-review-angle-line-by-line',
    description: 'The line-by-line diff-scan finder angle of the code-review skill — read every hunk plus the enclosing function',
  },

  // 2.1.160 — the code-review skill's finder angles B–E and the recall-biased
  // verify rubric ship as standalone string constants (shared between the
  // inline /code-review cells and the new bundled workflow script). Each is
  // pure markdown with no interpolation, so no identifierMap is needed.
  {
    matcher: t => t.includes('removed-behavior auditor'),
    name: 'Skill: Code Review (Angle B — removed-behavior auditor)',
    id: 'skill-code-review-angle-removed-behavior-auditor',
    description: 'The removed-behavior finder angle of the code-review skill — for every deleted/replaced line, name the invariant it enforced and check it is re-established',
  },
  {
    matcher: t => t.includes('cross-file tracer'),
    name: 'Skill: Code Review (Angle C — cross-file tracer)',
    id: 'skill-code-review-angle-cross-file-tracer',
    description: 'The cross-file finder angle of the code-review skill — for each changed function, trace its callers to flag broken contracts',
  },
  {
    matcher: t => t.includes('language-pitfall specialist'),
    name: 'Skill: Code Review (Angle D — language-pitfall specialist)',
    id: 'skill-code-review-angle-language-pitfall-specialist',
    description: "The language-pitfall finder angle of the code-review skill — scan for the classic pitfalls of the diff's language/framework",
  },
  {
    matcher: t => t.includes('wrapper/proxy correctness'),
    name: 'Skill: Code Review (Angle E — wrapper/proxy correctness)',
    id: 'skill-code-review-angle-wrapper-proxy-correctness',
    description: 'The wrapper/proxy finder angle of the code-review skill — when a type wraps another (cache, proxy, decorator), check the forwarding is faithful',
  },
  {
    matcher: t => t.includes('**PLAUSIBLE by default**'),
    name: 'Skill: Code Review (verify — PLAUSIBLE/REFUTED rubric)',
    id: 'skill-code-review-verify-plausible-refuted-rubric',
    description: 'The keep/kill rubric for the code-review verify phase — PLAUSIBLE by default, REFUTED only when constructible from the code',
  },

  // 2.1.160 — DesignSync tool, paired with the new design-sync skill. Reads and
  // updates the user's claude.ai/design design-system projects via their
  // claude.ai login; dispatches on a `method` field.
  {
    matcher: t =>
      t.includes(
        "Read and update the user's claude.ai/design design-system projects"
      ),
    name: 'Tool Description: DesignSync',
    id: 'tool-description-designsync',
    description: "Describes the DesignSync tool — reads/updates the user's claude.ai/design design-system projects through their claude.ai login, dispatching on a method field, paired with the /design-sync skill",
  },

  // 2.1.160 — bundled /code-review workflow script (export const meta = {...}
  // JS source, like the other workflow-script-* entries). Embeds the angle and
  // verdict-ladder fragments via ${JSON.stringify(...)} so they stay one source
  // of truth with the inline cells. Slot 0 is the repeated JSON global; slots
  // 1–4 are the standard meta fields; 5–10 are the embedded prompt fragments.
  {
    matcher: t =>
      t.includes('export const meta') && t.includes('// code-review: Scope'),
    name: 'Workflow Script: /code-review',
    id: 'workflow-script-code-review',
    description: 'Bundled /code-review workflow — scopes the diff, fans out per-angle finders, dedups, verifies, sweeps for gaps (xhigh/max), and synthesizes; effort-parameterized via LEVEL_PARAMS',
    identifierMap: {
      0: 'JSON',
      1: 'WORKFLOW_NAME',
      2: 'WORKFLOW_DESCRIPTION',
      3: 'WORKFLOW_WHEN_TO_USE',
      4: 'WORKFLOW_PHASES',
      5: 'CORRECTNESS_ANGLES',
      6: 'CLEANUP_ANGLES',
      7: 'VERDICT_LADDER',
      8: 'VERDICT_LADDER_RECALL',
      9: 'CLEANUP_PRECEDENCE',
      10: 'SWEEP_GAP_FOCUS',
    },
  },
  {
    // The memory-synthesis subagent has a single trailing ${...} interpolation
    // that resolves to "" in 2.1.150 — an inert hook for future conditional
    // notes. Naming it here so the override doesn't reference UNKNOWN_0.
    matcher: t =>
      t.startsWith(
        'You read persistent memory files for an AI coding assistant'
      ),
    name: 'Agent Prompt: Memory synthesis',
    id: 'agent-prompt-memory-synthesis',
    description:
      'Subagent that reads persistent memory files and returns a JSON synthesis of only the information relevant to each query, with cited filenames',
    identifierMap: { 0: 'OPTIONAL_TAIL_NOTE' },
  },
  // 2.1.145 — the "run" skill family (launch and drive a project's app):
  // /run + /run-skill-generator bundled skills plus their 6 shared example
  // docs and the run-<unit-name> template. Plus a new Managed Agents doc.
  // All registered unconditionally in the bundled-skills init; the skills
  // are conditional injections (only when the command fires).
  {
    matcher: t => t.startsWith('---\nname: run\n'),
    name: 'Skill: run',
    id: 'skill-run',
    description:
      "Bundled /run skill — launches and drives a project's actual app (CLI, server, TUI, Electron, browser, or library) to confirm a change works; prefers a project run skill, else falls back to built-in per-project-type patterns",
  },
  {
    matcher: t => t.startsWith('---\nname: run-<unit-name>\n'),
    name: 'Skill: run-<unit-name> (template)',
    id: 'skill-run-unit-name-template',
    description:
      'Template skeleton for a per-project run-<unit-name> skill, bundled as template.md inside run-skill-generator — prerequisites, setup, build, agent/human run paths, test, and gotchas sections',
  },
  {
    matcher: t => t.startsWith('---\nname: run-skill-generator\n'),
    name: 'Skill: run-skill-generator',
    id: 'skill-run-skill-generator',
    description:
      "Bundled /run-skill-generator skill (user-invocable only) — authors or improves a project's run-<unit> skill telling agents how to build, launch, and drive the app from a clean environment",
  },
  {
    matcher: t => t.startsWith('# Example: Browser-driven web app'),
    name: 'Skill: run example — Browser-driven web app',
    id: 'skill-run-example-browser-driven-web-app',
    description:
      'Bundled example doc (examples/playwright.md) for the run skill: driving a browser-based web app via a background dev server plus headless chromium-cli',
  },
  {
    matcher: t => t.startsWith('# Example: CLI tool'),
    name: 'Skill: run example — CLI tool',
    id: 'skill-run-example-cli-tool',
    description:
      'Bundled example doc (examples/cli.md) for the run skill: installing, invoking, and testing a command-line tool',
  },
  {
    matcher: t => t.startsWith('# Example: Electron / desktop GUI app'),
    name: 'Skill: run example — Electron / desktop GUI app',
    id: 'skill-run-example-electron',
    description:
      'Bundled example doc (examples/electron.md) for the run skill: launching an Electron desktop app under xvfb and driving it with a Playwright _electron REPL driver',
  },
  {
    matcher: t => t.startsWith('# Example: Library / SDK'),
    name: 'Skill: run example — Library / SDK',
    id: 'skill-run-example-library-sdk',
    description:
      'Bundled example doc (examples/library.md) for the run skill: building a library or SDK from source, running its test suite, and writing an import-and-call smoke script',
  },
  {
    matcher: t => t.startsWith('# Example: TUI / interactive terminal app'),
    name: 'Skill: run example — TUI / interactive terminal app',
    id: 'skill-run-example-tui',
    description:
      'Bundled example doc (examples/tui.md) for the run skill: driving an interactive terminal app by wrapping it in tmux send-keys / capture-pane',
  },
  {
    matcher: t => t.startsWith('# Example: Web server / API'),
    name: 'Skill: run example — Web server / API',
    id: 'skill-run-example-web-server-api',
    description:
      'Bundled example doc (examples/server.md) for the run skill: background-launching a web server or API, polling for readiness, smoke-testing with curl, and shutting it down cleanly',
  },
  {
    matcher: t =>
      t.startsWith('# Managed Agents') && t.includes('Self-Hosted Sandboxes'),
    name: 'Data: Managed Agents self-hosted sandboxes',
    id: 'data-managed-agents-self-hosted-sandboxes',
    description:
      'Managed Agents reference for self-hosted sandboxes (config.type: self_hosted) — running an EnvironmentWorker that keeps tool execution on infrastructure you control',
  },
  // 2.1.146 — the Workflow feature (WorkflowTool, env-gated behind
  // CLAUDE_CODE_WORKFLOWS). The tool runs a deterministic JS script that
  // orchestrates subagents; 10 bundled workflow scripts ship with it, plus
  // two subagent prompts. Items below for skill-code-review and
  // system-prompt-worker-instructions are existing prompts whose fuzzy
  // carryover broke when Anthropic renamed the `simplify` skill to
  // `code-review` (the first-100-char fingerprint prefix changed).
  {
    matcher: t => t.startsWith('# Code Review and Cleanup'),
    name: 'Skill: Code Review',
    id: 'skill-code-review',
    description:
      'Bundled /code-review skill (renamed from /simplify in 2.1.146) — reviews all changed files for reuse, quality, and efficiency across three parallel review agents and fixes issues found',
    identifierMap: { '0': 'AGENT_TOOL_NAME' },
  },
  {
    matcher: t => t.startsWith('After you finish implementing the change:'),
    name: 'System Prompt: Worker instructions',
    id: 'system-prompt-worker-instructions',
    description:
      'Post-implementation checklist injected for worker/subagent turns — run the code-review skill, run unit tests, test end-to-end',
    identifierMap: { '0': 'SKILL_TOOL_NAME' },
  },
  {
    matcher: t =>
      t.startsWith(
        'Execute a workflow script that orchestrates multiple subagents deterministically'
      ),
    name: 'Tool Description: Workflow',
    id: 'tool-description-workflow',
    description:
      'Describes the Workflow tool (alias RunWorkflow) — runs a deterministic JavaScript workflow script that orchestrates subagents via agent()/parallel()/pipeline()/phase(); env-gated behind CLAUDE_CODE_WORKFLOWS',
    // 5 interpolation slots, named by their role in the prompt text: three
    // are currently empty-string conditional notes, one is the 'worktree'
    // isolation literal, one is the ▸ glyph prefixing the /workflows group.
    identifierMap: {
      0: 'WORKFLOW_INVOCATION_QUALIFIER',
      1: 'WORKFLOW_RESEND_NOTE',
      2: 'WORKFLOW_ISOLATION_TYPE',
      3: 'WORKFLOW_WORKTREE_NOTE',
      4: 'WORKFLOW_GROUP_GLYPH',
    },
  },
  {
    matcher: t =>
      t.startsWith('You are a subagent spawned by a workflow orchestration script') &&
      t.includes('You MUST call the'),
    name: 'Agent Prompt: Workflow subagent structured output',
    id: 'agent-prompt-workflow-subagent-structured-output',
    description:
      'Prompt for a workflow-spawned subagent that must return its answer by calling a structured-output tool exactly once',
    identifierMap: { '0': 'STRUCTURED_OUTPUT_TOOL_NAME' },
  },
  {
    matcher: t =>
      t.startsWith('You are a subagent spawned by a workflow orchestration script') &&
      t.includes('returned **verbatim**'),
    name: 'Agent Prompt: Workflow subagent plain text output',
    id: 'agent-prompt-workflow-subagent-plain-text-output',
    description:
      'Prompt for a workflow-spawned subagent whose final text response is returned verbatim as a string to the calling script',
  },
  // 10 bundled workflow scripts (export const meta = {...} JS source).
  // Registered via initBundledWorkflows; matched on distinctive literal body
  // text since the name field is an interpolated ${...}. Every meta block has
  // the same 5 interpolation slots — name/description/whenToUse, then the
  // `${JSON.stringify(phases)}` pair — so they share one identifierMap.
  {
    matcher: t =>
      t.includes('export const meta') && t.includes('// ===== Phase 0: Scope ====='),
    name: 'Workflow Script: review-branch',
    id: 'workflow-script-review-branch',
    description:
      'Bundled review-branch workflow — scopes branch changes then runs multi-dimension review and verification',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') && t.includes('const FLEET_SIZE = 5'),
    name: 'Workflow Script: bughunt',
    id: 'workflow-script-bughunt',
    description:
      'Bundled bughunt workflow — a fleet of finders plus pigeonhole adversarial verification to surface real bugs',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') && t.includes('const RAPID_PROMPT = idx =>'),
    name: 'Workflow Script: bughunt-lite',
    id: 'workflow-script-bughunt-lite',
    description:
      'Bundled bughunt-lite workflow — a lighter bug hunt with rapid surface scanners and deep analysts',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') && t.includes("key: 'mvp',"),
    name: 'Workflow Script: plan-hunter',
    id: 'workflow-script-plan-hunter',
    description:
      'Bundled plan-hunter workflow — drafts and judges implementation plans across multiple lenses',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') && t.includes('// deep-research: Scope'),
    name: 'Workflow Script: deep-research',
    id: 'workflow-script-deep-research',
    description:
      'Bundled deep-research workflow — a scoped search pipeline with URL dedup, fetch/extract, and vote-based verification',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') &&
      t.includes('Command that runs the repro and fails'),
    name: 'Workflow Script: bugfix',
    id: 'workflow-script-bugfix',
    description:
      'Bundled bugfix workflow — reproduces a reported bug, implements a fix, and verifies it',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') &&
      t.includes('Path to an existing dashboard to pattern'),
    name: 'Workflow Script: dashboard',
    id: 'workflow-script-dashboard',
    description:
      'Bundled dashboard workflow — builds a dashboard, optionally patterned after an existing one',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') &&
      t.includes("['hypothesis', 'mechanism', 'predicts']"),
    name: 'Workflow Script: investigate',
    id: 'workflow-script-investigate',
    description:
      'Bundled investigate workflow — forms and tests hypotheses about a problem mechanism',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') &&
      t.includes('Where the new/updated doc should live'),
    name: 'Workflow Script: docs',
    id: 'workflow-script-docs',
    description:
      'Bundled docs workflow — writes or updates documentation for a target audience and conventions',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },
  {
    matcher: t =>
      t.includes('export const meta') && t.includes('const COMPLETENESS_SCHEMA = {'),
    name: 'Workflow Script: autopilot',
    id: 'workflow-script-autopilot',
    description:
      'Bundled autopilot workflow — plans a task, implements it, and judges completeness across blocker/major/minor holes',
    identifierMap: WORKFLOW_SCRIPT_IDENTIFIER_MAP,
  },

  // 2.1.151/2.1.152 — coordinator mode (multi-worker orchestration). CC ships
  // a new top-level system-prompt path: iG5() emits the coordinator prompt
  // when coordinator mode is active (SH("coordinator_mode_start")); workers
  // launched via the Agent tool receive Qw7() (getWorkerSystemPrompt).
  {
    matcher: t =>
      t.includes(
        'You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers'
      ),
    name: 'System Prompt: Coordinator mode',
    id: 'system-prompt-coordinator-mode',
    description:
      'Top-level CC system prompt when coordinator mode is active — orchestrates worker subagents through Agent/SendMessage/TaskStop, with optional cross-session peer discovery and workflow tool guidance',
    identifierMap: {
      0: 'AGENT_TOOL_NAME',
      1: 'SENDMESSAGE_TOOL_NAME',
      2: 'TASKSTOP_TOOL_NAME',
      3: 'WORKFLOW_CONDITIONAL_TOOL_NOTE',
      4: 'LISTAGENTS_TOOL_NAME',
      5: 'WORKER_TOOLS_INTRO_TEXT',
    },
  },
  {
    matcher: t =>
      t.includes('You are a worker agent executing a task assigned by the coordinator'),
    name: 'System Prompt: Worker agent',
    id: 'system-prompt-worker-agent',
    description:
      'System prompt for a worker subagent in coordinator mode — scoped execution, reports back to the coordinator (not the user) via task-note output',
    identifierMap: { 0: 'AGENT_TOOL_NAME' },
  },

  // 2.1.151/2.1.152 — /code-review --fix extension. The --fix flag appends
  // OEO to the assembled code-review prompt; tells the model to apply the
  // findings to the working tree instead of stopping at the report.
  {
    matcher: t => t.includes('## Applying fixes (--fix)'),
    name: 'Skill: Code Review (--fix applying fixes)',
    id: 'skill-code-review-applying-fixes',
    description:
      'Appended to the code-review prompt when --fix is passed; instructs applying each finding to the working tree, skipping behavior-changing or out-of-scope fixes',
  },

  // 2.1.151/2.1.152 — leading ${""} prefix shifted the tool-description-bash
  // commit/PR template; fuzzy carryover misses it. Same prompt as the
  // tool-description-bash-git-commit-and-pr-creation-instructions in 2.1.150,
  // with one extra identifier slot (T = future PR preamble stub, currently "").
  // Note: TASK_TOOL_NAME slot was renamed to AGENT_TOOL_NAME in 2.1.151+.
  {
    matcher: t => t.startsWith('${""}# Committing changes with git'),
    name: 'Tool Description: Bash (Git commit and PR creation instructions)',
    id: 'tool-description-bash-git-commit-and-pr-creation-instructions',
    description:
      'Embedded in the Bash tool description: end-to-end guidance for git commit and gh pr create workflows with safety protocol, staging rules, and HEREDOC formatting',
    identifierMap: {
      0: 'BASH_TOOL_NAME',
      1: 'COMMIT_CO_AUTHORED_BY_CLAUDE_CODE',
      2: 'TODO_TOOL_OBJECT',
      3: 'AGENT_TOOL_NAME',
      4: 'PR_PREAMBLE_STUB',
      5: 'PR_GENERATED_WITH_CLAUDE_CODE',
    },
  },

  // 2.1.151/2.1.152 — ultrareview help wording extended (was just /ultrareview;
  // now /code-review ultra with /ultrareview noted as deprecated alias).
  // Fuzzy carryover misses because the leading phrase changed.
  {
    matcher: t =>
      t.includes(
        '/code-review ultra launches a multi-agent cloud review of the current branch'
      ),
    name: 'System Prompt: Ultrareview help',
    id: 'system-prompt-ultrareview-help',
    description:
      "Session-specific guidance line surfaced when the user asks about 'ultrareview' — explains the /code-review ultra command (with /ultrareview as a deprecated alias) and that the agent cannot launch it itself",
  },

  // 2.1.161 — the action-safety prompt gained a `${k5q()?A:B}` conditional
  // opening (k5q is a memoized CLAUDE_CODE_OWNERSHIP_FRAME / tengu_walnut_prism
  // flag that appends "; approval in one context doesn't extend to the next.").
  // The new leading `${...}` changes the first 100 chars, so fuzzy carryover
  // dropped the name; the prompt itself is unchanged otherwise. Restore it.
  {
    matcher: t =>
      t.includes(
        'hard to reverse or outward-facing, confirm first unless durably authorized'
      ),
    name: 'System Prompt: Action safety and truthful reporting',
    id: 'system-prompt-action-safety-and-truthful-reporting',
    description:
      'Requires confirmation for irreversible or outward-facing actions, checking targets before destructive edits, and truthful reporting of outcomes',
  },
];

function lookupNewPromptAssignment(content) {
  for (const a of NEW_PROMPT_ASSIGNMENTS) {
    if (a.matcher(content)) {
      return {
        name: a.name,
        id: a.id,
        description: a.description,
        identifierMap: a.identifierMap,
      };
    }
  }
  return null;
}

function parseMarkdownFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const data = {};
  for (const line of content.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return data;
}

function inferPromptIdentity(content) {
  const frontmatter = parseMarkdownFrontmatter(content);
  if (
    frontmatter &&
    typeof frontmatter.name === 'string' &&
    frontmatter.name.trim()
  ) {
    const skillName = frontmatter.name.trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/.test(skillName) ||
      content.includes('TODO')
    ) {
      return null;
    }
    const description =
      typeof frontmatter.description === 'string'
        ? frontmatter.description.trim()
        : '';
    return {
      name: `Skill: ${skillName}`,
      id: `skill-${slugify(skillName)}`,
      description: description
        ? `Bundled ${skillName} skill — ${description}`
        : `Bundled ${skillName} skill`,
    };
  }

  return null;
}

function validateInput(text, minLength = 500) {
  if (!text || typeof text !== 'string') return false;

  // ////////////////
  // What to exclude.
  // ////////////////

  // Bundled skill build-tooling — executable JS/MJS source shipped inside a
  // skill, not model-facing prompt text. The design-sync skill (new in 2.1.160)
  // ships package-build.mjs and a validation script (#!/usr/bin/env node) plus
  // lib/*.mjs modules (ts-morph .d.ts extraction, esbuild bundling, storybook
  // adapters). Piebald excludes these too. Mirror the `#!/usr/bin/env bun` rule.
  if (text.startsWith('#!/usr/bin/env node')) return false;

  // @internal JSDoc annotations on staged-release Options fields (new in
  // 2.1.169: supportedDialogKinds dialog-kind gating, retracted-message uuid
  // wiring). TS doc-comments the AST walk surfaces as prose — not model-facing
  // prompt text, no override target.
  if (text.startsWith('@internal ')) return false;
  // The lib/*.mjs ESM modules open with a `// ` banner comment and carry both an
  // `import ... from '...'` line and a top-level `export` — a shape no prompt has.
  if (
    /^\/\/ /.test(text) &&
    /\nimport\s.+\sfrom\s['"]/.test(text) &&
    /\nexport\s+(function|const|default|\{)/.test(text)
  )
    return false;

  // Runtime-hardening IIFEs the bundler emits in 2.1.165 (`(() => { ... })`):
  // an Error.prepareStackTrace lockdown and a WeakMap/Array snapshot guard.
  // These are executable code, not model-facing prompt text.
  if (text.startsWith('(() => {')) return false;

  // claude-in-chrome browser MCP tool descriptions are embedded in cli.js as a
  // tool-definition array but are not part of the catalogued prompt set (no
  // sibling browser tool is catalogued, and none were through 2.1.162). 2.1.165
  // extended file_upload's description enough to trip an include heuristic; drop
  // it to stay consistent with the baseline.
  if (
    text.startsWith(
      'Upload one or multiple files to a file input element on the page'
    )
  )
    return false;

  // Two general-purpose-agent fragments the current extractor surfaces that
  // have no working override target, so cataloging either only produces a
  // "Could not find" at apply. Drop both — the live agent-prompt-general-purpose
  // and agent-prompt-general-purpose-short already cover the text.
  //
  // 1. The strengths/guidelines half: general-purpose is authored as
  //    `intro + ${`strengths`}`, so this inline template literal is kept by the
  //    ${-interpolation exception in the subset filter. Its only occurrence is
  //    inside general-purpose's span (which fully inlines it), so an override
  //    can never match independently.
  if (
    text.startsWith(
      'Your strengths:\n- Searching for code, configurations, and patterns across large codebases'
    )
  )
    return false;

  // 2. The fallback agent prompt (bzK), used in the agent runner's catch path.
  //    It is the intro + concise-report directive without the strengths block.
  //    agent-prompt-general-purpose-short's text is a prefix of it and occurs at
  //    both sites, so the short-variant override (applied with a global pattern)
  //    clobbers this fragment's opening first — no override of it can ever match.
  if (
    text.startsWith('You are an agent for Claude Code, Anthropic') &&
    text.includes('When you complete the task, respond with a concise report') &&
    !text.includes('Your strengths') &&
    text.trimEnd().endsWith('so it only needs the essentials.')
  )
    return false;

  // ////////////////
  // What to include.
  // ////////////////

  // Context about Git status
  if (text.startsWith('This is the git status')) return true;

  // Include the system reminder accompanying every Read tool.
  if (text.includes('Whenever you read a file, you should consider whether it')) return true;

  // Another prompt smaller then 500 characters that should be included
  if (text.includes('IMPORTANT: Assist with authorized security testing'))
    return true;

  // Markdown skill / data-doc / section-headed prompt: any text 300+
  // chars starting with `# Header`, `## Header`, or `### Header` is a real
  // prompt regardless of the English-keyword heuristic below. Catches
  // skills (`# Anthropic CLI`), section-prefixed system prompts
  // (`\n## Insights\n...`), and shorter section fragments like
  // `# Focus mode`, `# Language`, `# Autonomous loop tick`.
  if (text.length >= 300 && /^\s*#{1,3} [A-Z]/.test(text)) return true;

  // Tool / agent / skill descriptions that open with a directive verb and
  // are bullet-heavy markdown (fail the sentence-pattern check below).
  // Catches TaskUpdate / TaskList / TaskGet / Agent / claude-code-guide
  // descriptions, schedule skill, settings-locations skill, etc.
  // NOTE: do NOT add `Your version of Claude Code` here — that is the
  // outdated-version banner, excluded below. As of 2.1.145 its interpolated
  // ${{ISSUES_EXPLAINER,PACKAGE_URL,...}} object pushes it past 400 chars, so
  // an include rule here would shadow the exclude and leak 2 junk entries.
  if (text.length >= 400 && /^\s*(Use this (?:tool|skill|agent)|Your strengths:|<system-reminder>)/.test(text)) return true;

  // Specific medium-length prompts (400–500c) that open with directive
  // patterns. Each entry is anchored to text confirmed unique in 2.1.141
  // cli.js. `trimStart` lets us catch leading-whitespace variants (some
  // cli.js templates open with `\n` before the directive verb).
  const ts = text.trimStart();
  if (text.includes('Provide a concise response based only on the content above')) return true;
  if (ts.startsWith('Find elements on the page using natural language')) return true;
  if (ts.startsWith('Your plan has been submitted to the team lead for approval')) return true;
  if (ts.startsWith("I'm sending this plan to Ultraplan to be refined remotely")) return true;
  if (text.includes('If the user asks about "ultrareview" or how to run it')) return true;
  if (text.includes('If they want a one-time run (e.g., "once at 3pm"')) return true;
  if (ts.startsWith('You are an interactive agent that helps users')) return true;
  if (ts.startsWith("You are an agent for Claude Code, Anthropic's official CLI")) return true;

  // Very short interpolated fragments (under 100 chars) that ship in
  // cli.js. Bash-alt-* tool sub-descriptions and subagent-guidance.
  if (ts.startsWith('Edit files: Use ${')) return true;
  if (ts.startsWith('Read files: Use ${')) return true;
  if (ts.startsWith('Write files: Use ${')) return true;
  if (ts.startsWith('File search: Use ${')) return true;
  if (ts.startsWith('Content search: Use ${')) return true;
  if (ts.startsWith('Use the ${') && ts.includes('tool with specialized agents')) return true;
  if (ts.startsWith('Contents of ${') && ts.includes(':')) return true;

  // ////////////////
  // Short-prompt allow-list: distinctive substrings of prompts under 500
  // chars that the length check below would otherwise drop. Compiled by
  // cross-referencing Piebald's published 2.1.140 JSON against the cli.js
  // for 2.1.141 — each entry is a substring confirmed unique enough not to
  // false-positive within the prompts set.
  //
  // Mirrors PR #731 (Add include rules for short system prompt fragments)
  // from the upstream Piebald repo plus an additional batch we compiled
  // here. If PR #731 merges upstream, the overlapping entries will be
  // deduped on the next `git merge upstream/main`.
  // ////////////////

  // PR #731 — short fragments from the doing-tasks / tone-and-style / memory sections.
  if (text.includes('exploratory questions')) return true;
  if (text.includes('well-named identifiers already do that')) return true;
  if (text.includes('golden path and edge cases')) return true;
  if (text.includes('Prefer editing existing files')) return true;
  if (text.includes('Default to writing no comments')) return true;
  if (text.startsWith("Don't add features, refactor")) return true;
  if (text.includes('Only use emojis if the user explicitly')) return true;
  if (text === 'Your responses should be short and concise.') return true;
  if (text.includes('Do not use a colon before tool calls')) return true;
  if (text.includes('What NOT to save in memory')) return true;

  // Agent / skill / system / tool short prompts that ship in 2.1.141 and earlier.
  if (text.includes('Generate a short kebab-case name (2-4 wo')) return true;
  if (text.includes('The user just ran /insights to generate')) return true;
  if (text.includes('You are highly capable and often allow u')) return true;
  if (text.includes('The user will primarily request you to p')) return true;
  if (text.includes('If the user asks for help or wants to gi')) return true;
  if (text.includes('Avoid backwards-compatibility hacks like')) return true;
  if (text.includes("Don't add error handling, fallbacks, or")) return true;
  if (text.includes('Be careful not to introduce security vul')) return true;
  if (text.includes('Do not retry failing commands ')) return true;
  if (text.includes('When referencing specific functions or p')) return true;
  if (text.includes('You have exited plan mode. You can now')) return true;
  if (text.includes('minder>Warning: the file exists but the')) return true;
  if (text.includes('minder>Warning: the file exists but is s')) return true;
  if (text.includes('hook stopped continuation:')) return true;
  if (text.includes('<new-diagnostics>The following new diagn')) return true;
  if (text.includes('This session is being continued from ano')) return true;
  if (text.includes("The task tools haven't been used recentl")) return true;
  if (text.includes("The TodoWrite tool hasn't been used rece")) return true;
  if (text.includes('You have completed implementing the plan')) return true;
  if (text.includes('ion: Output text directly (NOT echo/prin')) return true;
  if (text.includes('Before running destructive ope')) return true;
  if (text.includes('Never skip hooks (--no-verify)')) return true;
  if (text.includes('Prefer to create a new commit ')) return true;
  if (text.includes('Try to maintain your current working dir')) return true;
  if (text.includes('DO NOT use newlines to separat')) return true;
  if (text.includes('Executes a given bash command and return')) return true;
  if (text.includes('If the commands are independen')) return true;
  if (text.includes('Always quote file paths that c')) return true;
  if (text.includes('If a command fails due to sandbox restri')) return true;
  if (text.includes('You should always default to running com')) return true;
  if (text.includes('Access denied to specific paths outside')) return true;
  if (text.includes('Evidence of sandbox-caused failures incl')) return true;
  if (text.includes('Network connection failures to non-white')) return true;
  if (text.includes('"Operation not permitted" errors for fil')) return true;
  if (text.includes('Unix socket connection er')) return true;
  if (text.includes('Briefly explain what sandbox restriction')) return true;
  if (text.includes('A specific command just failed and you s')) return true;
  if (text.includes('All commands MUST run in sandbox mode -')) return true;
  if (text.includes('Commands cannot run outside the sandbox')) return true;
  if (text.includes('Do not suggest adding sensitive paths li')) return true;
  if (text.includes('Treat each command you execute with `dan')) return true;
  if (text.includes('This will prompt the user for permission')) return true;
  if (text.includes('When you see evidence of sandbox-caused')) return true;
  if (text.includes('Immediately retry with `dangerouslyDisab')) return true;
  if (text.includes('For temporary files, always use the `$TM')) return true;
  if (text.includes("Use ';' only when you need to run comman")) return true;
  if (text.includes('If the commands depend on each')) return true;
  if (text.includes('If you must sleep, keep the du')) return true;
  if (text.includes('If waiting for a background ta')) return true;
  if (text.includes('Do not sleep between commands ')) return true;
  if (text.includes('external process, use a check command (e')) return true;
  if (text.includes('You may specify an optional timeout in m')) return true;
  if (text.includes('If your command will create new director')) return true;
  if (text.includes('The working directory persists between c')) return true;
  if (text.includes('Writes a file to the local filesystem, o')) return true;

  // Short prompts new in a CC version: NEW_PROMPT_ASSIGNMENTS doubles as
  // an inclusion gate (here) and a naming source (mergeWithExisting fallback).
  if (lookupNewPromptAssignment(text)) return true;
  if (inferPromptIdentity(text)) return true;

  // System-reminder short fragments and a few specific tool-description /
  // system-prompt fragments shipped under 500 chars in 2.1.141.
  if (text.startsWith('Stop hook blocking error from command')) return true;
  if (text.startsWith('The user opened the file ') && text.includes('in the IDE')) return true;
  if (text.includes('The user selected the lines ')) return true;
  if (text.includes('The user has expressed a desire to invoke the agent')) return true;
  if (text.startsWith('A plan file exists from plan mode at:')) return true;
  if (text.includes('IMPORTANT: Avoid using this tool to run')) return true;
  if (text.startsWith('Break down and manage your work with the')) return true;

  // ////////////////
  // What to exclude.
  // ////////////////

  // In one specific case, some of the TUI code shows up in the prompts files.  Exclude it.
  if (text.includes('.dim("Note:')) return false;

  // CLI help text for `claude mcp add` is not a prompt - it's user-facing documentation.
  if (text.startsWith('Add an MCP server to Claude Code.')) return false;

  // Skip the warning about keybindings when connecting to a remote server.
  if (text.includes('Cannot install keybindings from a remote')) return false;

  // HTML output from the /insights report (and similar). Not a prompt.
  if (text.startsWith('<!DOCTYPE html>') || text.startsWith('<html')) return false;
  if (/^\s*<h\d[\s>]/.test(text)) return false;

  // `claude` CLI help screens (Remote Control feature et al). Not prompts.
  if (text.includes('Remote Control - Control local sessions from claude.ai/code'))
    return false;

  // CC version-update banner shown to users when their install is outdated.
  if (text.startsWith('Your version of Claude Code (')) return false;

  // Bun-compiled script template embedded in cli.js for spawned subprocesses.
  if (text.startsWith('#!/usr/bin/env bun')) return false;

  // JSON-schema-style config option descriptions (not prompts). Pattern:
  // `When true, ...` followed by `Equivalent to setting <flag>: false on
  // the API.` These appear as tool/server config docstrings.
  if (
    text.startsWith('When true, ') &&
    text.includes('Equivalent to setting ') &&
    text.includes(' on the API')
  )
    return false;

  if (text.length < minLength) return false;

  const first10 = text.substring(0, 10);
  if (first10.startsWith('AGFzbQ') || /^[A-Z0-9+/=]{10}$/.test(first10)) {
    return false;
  }

  const sample = text.substring(0, 500);
  const words = sample.split(/\s+/).filter(w => w.length > 0);

  if (words.length === 0) return false;

  const uppercaseWords = words.filter(
    w => w === w.toUpperCase() && /[A-Z]/.test(w)
  );
  const uppercaseRatio = uppercaseWords.length / words.length;

  if (uppercaseRatio > 0.6) {
    return false;
  }

  const lowerText = text.toLowerCase();
  const hasYou = lowerText.includes('you');
  const hasAI = lowerText.includes('ai') || lowerText.includes('assistant');
  const hasInstruct =
    lowerText.includes('must') ||
    lowerText.includes('should') ||
    lowerText.includes('always');

  if (!hasYou && !hasAI && !hasInstruct) {
    return false;
  }

  const sentencePattern = /[.!?]\s+[A-Z\(]/;
  const hasSentences = sentencePattern.test(text);
  if (!hasSentences) {
    return false;
  }

  const avgWordLength =
    words.reduce((sum, w) => sum + w.length, 0) / words.length;

  if (avgWordLength > 15) {
    return false;
  }

  const spaceCount = (sample.match(/\s/g) || []).length;
  const spaceRatio = spaceCount / sample.length;

  if (spaceRatio < 0.1) {
    return false;
  }

  return true;
}

// Decode JS unicode/hex escape sequences in template-literal raw source.
// Surgical: only handles \uHHHH, \u{X+}, \xHH. Preserves `\\` so literal
// `\\uHHHH` source (= backslash + u + four hex chars at runtime) isn't
// accidentally interpreted as an escape. Other escapes (\n, \t, \", \`)
// are kept raw to match the storage format Piebald's published JSONs use.
function decodeUnicodeEscapesInPiece(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      // Double-backslash: copy both literally so the next char isn't read as an escape.
      if (s[i + 1] === '\\') {
        out += '\\\\';
        i += 2;
        continue;
      }
      if (s[i + 1] === 'u') {
        if (s[i + 2] === '{') {
          const close = s.indexOf('}', i + 3);
          if (close > -1) {
            const hex = s.substring(i + 3, close);
            if (/^[0-9a-fA-F]+$/.test(hex)) {
              out += String.fromCodePoint(parseInt(hex, 16));
              i = close + 1;
              continue;
            }
          }
        } else if (i + 6 <= s.length) {
          const hex = s.substring(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
        }
      }
      if (s[i + 1] === 'x' && i + 4 <= s.length) {
        const hex = s.substring(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

function extractStrings(filepath, minLength = 500) {
  const code = fs.readFileSync(filepath, 'utf-8');

  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const stringData = [];

  const traverse = node => {
    if (!node || typeof node !== 'object') return;

    // Extract string literals
    if (node.type === 'StringLiteral') {
      if (validateInput(node.value, minLength)) {
        stringData.push({
          name: '',
          id: '',
          description: '',
          pieces: [node.value],
          identifiers: [],
          identifierMap: {},
          start: node.start,
          end: node.end,
        });
      }
    }

    // Extract template literals
    if (node.type === 'TemplateLiteral') {
      const { expressions } = node;

      // Extract the entire template content directly from source (excluding backticks)
      const contentStart = node.start + 1; // After opening backtick
      const contentEnd = node.end - 1; // Before closing backtick
      const fullContent = code.substring(contentStart, contentEnd);

      // Validate before processing
      if (!validateInput(fullContent, minLength)) {
        return;
      }

      // Collect all identifiers with their positions
      const allIdentifiers = []; // Array of {name, start, end} sorted by position

      for (let i = 0; i < expressions.length; i++) {
        const expr = expressions[i];

        const traverseExpr = (exprNode, isTopLevel = true) => {
          if (!exprNode || typeof exprNode !== 'object') return;

          if (exprNode.type === 'Identifier' && isTopLevel) {
            allIdentifiers.push({
              name: exprNode.name,
              start: exprNode.start - contentStart,
              end: exprNode.end - contentStart,
            });
          }

          if (exprNode.type === 'CallExpression') {
            traverseExpr(exprNode.callee, true);
            if (exprNode.arguments) {
              exprNode.arguments.forEach(arg => traverseExpr(arg, true));
            }
            return;
          }

          if (exprNode.type === 'MemberExpression') {
            traverseExpr(exprNode.object, true);
            return;
          }

          if (exprNode.type === 'TemplateLiteral') {
            if (exprNode.expressions) {
              exprNode.expressions.forEach(nestedExpr =>
                traverseExpr(nestedExpr, true)
              );
            }
            return;
          }

          if (exprNode.type === 'ObjectExpression') {
            if (exprNode.properties) {
              exprNode.properties.forEach(prop => {
                if (prop.value) {
                  traverseExpr(prop.value, false);
                }
              });
            }
            return;
          }

          for (const key in exprNode) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            const value = exprNode[key];
            if (Array.isArray(value)) {
              value.forEach(v => traverseExpr(v, true));
            } else if (value && typeof value === 'object') {
              traverseExpr(value, true);
            }
          }
        };

        traverseExpr(expr, true);
      }

      // Sort identifiers by position
      allIdentifiers.sort((a, b) => a.start - b.start);

      // Build pieces array by splitting around identifiers, keeping ${ and }
      const pieces = [];
      const identifierList = [];
      const identifierMap = {};

      let lastPos = 0;

      for (const id of allIdentifiers) {
        // Find the ${ before this identifier (search backwards from id.start)
        let beforeIdentifier = fullContent.substring(lastPos, id.start);

        // Find the } after this identifier (search forwards from id.end)
        // We need to find the matching closing brace for the interpolation
        let afterIdentifierStart = id.end;

        // Add the piece including everything up to and including just before the identifier
        pieces.push(beforeIdentifier);

        // Add identifier to the list
        identifierList.push(id.name);

        // Add to map if not already there
        if (!identifierMap[id.name]) {
          identifierMap[id.name] = '';
        }

        lastPos = id.end;
      }

      // Add the final piece after the last identifier
      pieces.push(fullContent.substring(lastPos));

      // Decode unicode/hex escapes in each piece. Template-literal raw source
      // stores `—` as 6 literal chars; the cooked runtime value is the
      // em-dash. Decoding here keeps our pieces[] byte-aligned with the
      // pristine prompt content in cli.js's parse tree — same format Piebald's
      // pipeline produces, so merge name-carryover works across versions.
      for (let pi = 0; pi < pieces.length; pi++) {
        pieces[pi] = decodeUnicodeEscapesInPiece(pieces[pi]);
      }

      // Label encode the identifiers
      const uniqueVars = [...new Set(identifierList)];
      const varToLabel = {};
      uniqueVars.forEach((varName, idx) => {
        varToLabel[varName] = idx;
      });

      const labelEncodedIdentifiers = identifierList.map(
        varName => varToLabel[varName]
      );
      const labelEncodedMap = {};
      Object.keys(varToLabel).forEach(varName => {
        labelEncodedMap[varToLabel[varName]] = '';
      });

      stringData.push({
        name: '',
        id: '',
        description: '',
        pieces,
        identifiers: labelEncodedIdentifiers,
        identifierMap: labelEncodedMap,
        start: node.start,
        end: node.end,
      });
    }

    // Recursively traverse
    for (const key in node) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;

      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(traverse);
      } else if (value && typeof value === 'object') {
        traverse(value);
      }
    }
  };

  traverse(ast);

  // Filter out strings that are subsets of other strings
  // Step 1: Sort by start index (ascending), then by end index (descending)
  // This puts earliest strings first, and among strings with same start, longest first
  stringData.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - a.end;
  });

  // Step 2: Track seen ranges and filter out subsets.
  // Exception: items starting immediately after `${` are interpolated
  // values inside a larger template — semantically distinct prompts that
  // happen to be nested. Don't drop them as subsets of the outer.
  const seenRanges = [];
  const filteredData = [];

  for (const item of stringData) {
    const isInterpolated =
      item.start >= 2 &&
      code[item.start - 2] === '$' &&
      code[item.start - 1] === '{';

    const isSubset =
      !isInterpolated &&
      seenRanges.some(
        range => item.start >= range.start && item.end <= range.end
      );

    if (!isSubset) {
      filteredData.push(item);
      seenRanges.push({ start: item.start, end: item.end });
    }
  }

  return { prompts: filteredData };
}

function mergeWithExisting(newData, oldData, currentVersion) {
  if (!oldData || !oldData.prompts) {
    // No old data, add current version to all new prompts
    return {
      prompts: newData.prompts.map(item => ({
        ...item,
        version: currentVersion,
      })),
    };
  }

  // Helper to reconstruct content from pieces and identifiers
  const reconstructContent = item => {
    return item.pieces.join(''); // Don't actually insert the vairables.
  };

  // Fingerprint normalization: Piebald's pipeline stores source-form escapes
  // (`\'`, `\"`, `` \` ``) in StringLiteral pieces, while our extractor uses
  // babel's cooked node.value (escapes decoded). Strip these escape forms
  // before fingerprinting so the prefix compares equal across pipelines.
  const fpNormalize = s => s.replace(/\\(['"`\\])/g, '$1');

  // Fuzzy-fingerprint index: prompts whose content shifted slightly between
  // versions still have an unchanged opening. We index old prompts by their
  // normalized first 100 chars and drop collisions so we never carry over
  // the wrong name. Built once per merge — O(n) — and consulted only when
  // the strict content+identifier match fails.
  const FUZZY_PREFIX = 100;
  const FUZZY_MIN = 60;
  const fpCounts = new Map();
  const fpToOld = new Map();
  for (const oldItem of oldData.prompts) {
    if (!oldItem.id) continue; // no carryover value without a name
    const fp = fpNormalize(reconstructContent(oldItem)).slice(0, FUZZY_PREFIX);
    if (fp.length < FUZZY_MIN) continue;
    fpCounts.set(fp, (fpCounts.get(fp) || 0) + 1);
    fpToOld.set(fp, oldItem);
  }
  for (const [fp, count] of fpCounts) if (count > 1) fpToOld.delete(fp);

  const newPrompts = newData.prompts.map((newItem, idx) => {
    const newContent = reconstructContent(newItem);

    // Try to find a matching old item by content and label-encoded identifiers
    const matchingOld = oldData.prompts.find(oldItem => {
      const oldContent = reconstructContent(oldItem);
      if (newContent !== oldContent) return false;

      // Also compare label-encoded identifiers
      if (newItem.identifiers.length !== oldItem.identifiers.length)
        return false;
      return (
        JSON.stringify(newItem.identifiers) ===
        JSON.stringify(oldItem.identifiers)
      );
    });

    // If we found a match, copy over the metadata
    if (matchingOld) {
      // Prompt matches exactly
      // If old prompt has no version, use current version; otherwise use old version
      // Overlay NEW_PROMPT_ASSIGNMENTS.identifierMap when it provides one — lets us
      // backfill semantic names onto prompts whose carried-over identifierMap was
      // empty (originated from a version before we knew the slot semantics).
      const assignedFromMap = lookupNewPromptAssignment(newContent);
      const overlaidIdentifierMap = assignedFromMap && assignedFromMap.identifierMap
        ? { ...matchingOld.identifierMap, ...assignedFromMap.identifierMap }
        : matchingOld.identifierMap;
      return {
        ...newItem,
        name: matchingOld.name,
        id: matchingOld.id || slugify(matchingOld.name),
        description: matchingOld.description,
        identifierMap: overlaidIdentifierMap,
        version: matchingOld.version || currentVersion,
      };
    }

    // Fuzzy match: same prompt across versions, content shifted by a few
    // chars. Carry over the identity (name/id/description/identifierMap)
    // and bump version since pieces changed.
    const fp = fpNormalize(newContent).slice(0, FUZZY_PREFIX);
    const fuzzyOld = fp.length >= FUZZY_MIN ? fpToOld.get(fp) : undefined;
    if (fuzzyOld) {
      const oldLen = reconstructContent(fuzzyOld).length;
      console.log(
        `Fuzzy-matched item ${idx} to "${fuzzyOld.name || fuzzyOld.id}" (${oldLen} → ${newContent.length} chars)`
      );
      const assignedFromMap = lookupNewPromptAssignment(newContent);
      const overlaidIdentifierMap = assignedFromMap && assignedFromMap.identifierMap
        ? { ...fuzzyOld.identifierMap, ...assignedFromMap.identifierMap }
        : fuzzyOld.identifierMap;
      return {
        ...newItem,
        name: fuzzyOld.name,
        id: fuzzyOld.id || slugify(fuzzyOld.name),
        description: fuzzyOld.description,
        identifierMap: overlaidIdentifierMap,
        version: currentVersion,
      };
    }

    // No exact match found - check if there's a prompt with same metadata but different content
    const similarOld = oldData.prompts.find(oldItem => {
      // Check if names match (not placeholder) as a heuristic for "same prompt, different content"
      return oldItem.name !== '' && oldItem.name === newItem.name;
    });

    if (similarOld && similarOld.version) {
      // Old prompt exists with a version and content changed - use current version
      console.log(
        `Content changed for "${newItem.name}", updating version from ${similarOld.version} to ${currentVersion}`
      );
      return {
        ...newItem,
        id: similarOld.id || slugify(similarOld.name),
        version: currentVersion,
      };
    }

    // Check if there's any old prompt without a version (we should add current version)
    const oldWithoutVersion = oldData.prompts.find(oldItem => !oldItem.version);

    // Hand-curated or high-confidence inferred assignment for prompts new in this CC version.
    const assigned =
      lookupNewPromptAssignment(newContent) || inferPromptIdentity(newContent);
    if (assigned) {
      console.log(
        `Assigned new prompt item ${idx} → "${assigned.id}"`
      );
      // If the assignment provides identifierMap (semantic names for the
      // ${var.field} interpolations), use it. Override files reference these
      // semantic names — without them, syncPrompt falls back to UNKNOWN_<idx>.
      const finalIdentifierMap = assigned.identifierMap
        ? { ...newItem.identifierMap, ...assigned.identifierMap }
        : newItem.identifierMap;
      return {
        ...newItem,
        name: assigned.name,
        id: assigned.id,
        description: assigned.description || newItem.description || '',
        identifierMap: finalIdentifierMap,
        version: currentVersion,
      };
    }

    // New prompt or old prompt didn't have version - add current version
    console.log(
      `No match for item ${idx}: ${JSON.stringify(newContent.slice(0, 100))}`
    );
    console.log();
    return {
      ...newItem,
      id: slugify(newItem.name),
      version: currentVersion,
    };
  });

  return { prompts: newPrompts };
}

// CLI
if (require.main === module) {
  const filepath = process.argv[2];

  if (!filepath) {
    console.error(
      'Usage: node promptExtractor.cjs <path-to-cli.js> [output-file]'
    );
    process.exit(1);
  }

  const outputFile = process.argv[3] || 'prompts.json';

  // Try to read existing output file
  let existingData = null;
  if (fs.existsSync(outputFile)) {
    try {
      const existingContent = fs.readFileSync(outputFile, 'utf-8');
      existingData = JSON.parse(existingContent);
      console.log(
        `Found existing output file with ${existingData.prompts?.length || 0} prompts`
      );
    } catch (err) {
      console.warn(
        `Warning: Could not parse existing output file: ${err.message}`
      );
    }
  }

  // Look for package.json alongside the input file
  const path = require('path');
  const inputDir = path.dirname(path.resolve(filepath));
  const packageJsonPath = path.join(inputDir, 'package.json');

  let version = null;
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      version = packageJson.version;
      console.log(`Found package.json with version ${version}`);
    } catch (err) {
      console.warn(`Warning: Could not parse package.json: ${err.message}`);
    }
  }

  // Helper functions to replace version strings with placeholder
  const replaceVersionInString = (str, versionStr) => {
    if (!versionStr) return str;
    // Escape dots for regex
    const escapedVersion = versionStr.replace(/\./g, '\\.');
    // Replace version with placeholder
    return str.replace(new RegExp(escapedVersion, 'g'), '<<CCVERSION>>');
  };

  // Helper function to replace BUILD_TIME timestamps with placeholder
  // BUILD_TIME is an ISO 8601 timestamp like "2025-12-09T19:43:43Z"
  const replaceBuildTimeInString = str => {
    // Match ISO 8601 timestamps in the format YYYY-MM-DDTHH:MM:SSZ
    // Only match when preceded by BUILD_TIME:" to avoid false positives
    return str.replace(
      /BUILD_TIME:"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/g,
      'BUILD_TIME:"<<BUILD_TIME>>"'
    );
  };

  const replaceVersionInPrompts = (data, versionStr) => {
    return {
      ...data,
      prompts: data.prompts.map(prompt => ({
        ...prompt,
        pieces: prompt.pieces.map(piece => {
          let result = piece;
          // Replace BUILD_TIME first (always)
          result = replaceBuildTimeInString(result);
          // Then replace version if provided
          if (versionStr) {
            result = replaceVersionInString(result, versionStr);
          }
          return result;
        }),
      })),
    };
  };

  const result = extractStrings(filepath);
  // Replace version in newly extracted strings BEFORE merging
  const versionReplacedResult = replaceVersionInPrompts(result, version);

  const mergedResult = mergeWithExisting(
    versionReplacedResult,
    existingData,
    version
  );

  // For every prompt upstream also ships whose `identifiers` array matches ours,
  // take upstream's identifierMap. Upstream labels every slot, so it is the
  // authoritative placeholder<->slot binding for shared prompts; only net-new
  // prompts (upstream lacks them) keep our carried/curated names. This is what
  // keeps an override's `${NAME}` landing on the slot it means. Point
  // TWEAKCC_UPSTREAM_JSON at upstream's prompts-<ver>.json.
  if (
    process.env.TWEAKCC_UPSTREAM_JSON &&
    fs.existsSync(process.env.TWEAKCC_UPSTREAM_JSON)
  ) {
    try {
      const up = JSON.parse(
        fs.readFileSync(process.env.TWEAKCC_UPSTREAM_JSON, 'utf-8')
      );
      const upById = new Map();
      for (const p of up.prompts || []) if (p.id) upById.set(p.id, p);
      let adopted = 0;
      for (const p of mergedResult.prompts) {
        const u = p.id && upById.get(p.id);
        if (
          u &&
          u.identifierMap &&
          JSON.stringify(u.identifiers) === JSON.stringify(p.identifiers)
        ) {
          p.identifierMap = { ...u.identifierMap };
          adopted++;
        }
      }
      console.log(`Adopted upstream identifierMap for ${adopted} shared prompt(s)`);
    } catch (err) {
      console.warn(
        `Warning: could not apply upstream identifierMaps: ${err.message}`
      );
    }
  }

  // Normalize empty identifierMap names to stable synthetic names. An empty
  // name forces applyIdentifierMapping's `UNKNOWN_<slot>` fallback, which ships
  // a latent ReferenceError risk and unreadable overrides; it happens for
  // prompts whose interpolations are complex expressions (ternaries, `??`,
  // method/function calls) the curated NEW_PROMPT_ASSIGNMENTS table doesn't
  // name. Synthetic name = <ID_SLUG>_VAR_<slot>: unique per prompt+slot and
  // stable across re-extraction, so overrides referencing it keep binding.
  // Curated/real names always win (this only fills blanks).
  for (const p of mergedResult.prompts) {
    if (!p.identifierMap) continue;
    const slug =
      String(p.id || 'prompt')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase() || 'PROMPT';
    for (const k of Object.keys(p.identifierMap)) {
      if (!p.identifierMap[k]) {
        p.identifierMap[k] = `${slug}_VAR_${k}`;
      }
    }
  }

  // Sort prompts by lexicographic order of pieces joined together (without interpolated vars)
  mergedResult.prompts.sort((a, b) => {
    const contentA = a.pieces.join('');
    const contentB = b.pieces.join('');
    return contentA.localeCompare(contentB);
  });

  // Remove start/end fields before writing
  mergedResult.prompts = mergedResult.prompts.map(({ start, end, ...rest }) => rest);

  // Add version as top-level field
  const outputData = {
    version,
    ...mergedResult,
  };

  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));

  console.log(`Extracted ${mergedResult.prompts.length} strings`);
  console.log(`Written to ${outputFile}`);
}

module.exports = extractStrings;
