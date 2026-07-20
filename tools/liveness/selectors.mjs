// Selector matrix for the loopback liveness capture.
//
// One row per SELECTOR that changes the maintained prompt set — never a
// cross-product. Each row is a spawn recipe (argv + env deltas) plus the
// canaries that are true FOR THAT ROW. Adding a row is a config change here;
// no other file needs to know about it.
//
// Selector reference (minified names as of the 2.1.215 bundle):
//   dn()          !isInteractive — print vs interactive
//   I6()          subagent steer variant
//   d_e()         fork-context enabled
//   oa()==="pro"  plan tier
//   OS(model)     lean/velvet gate — opus-4-8 resolves lean
//   ADs()         ownership frame

export const SELECTOR_KEYS = ['dn', 'I6', 'd_e', 'oa', 'OS', 'ADs'];

const GREP = { tool: 'Grep' };

// Both canaries below guard the same bug class from opposite sides: a prompt
// spliced at a backtick site can lose its backslashes, turning the runtime
// regex `function\s+\w+` into the meaningless literal `functions+w+`. Asserting
// only the positive would pass on an empty description, so the negative pins it.
const grepBackslashCanaries = [
  {
    id: 'grep-regex-backslashes-survive',
    where: GREP,
    mustContain: 'function\\s+\\w+',
    why: 'backslashes eaten at a backtick splice site',
  },
  {
    id: 'grep-regex-backslashes-not-eaten',
    where: GREP,
    mustNotContain: 'functions+w+',
    why: 'collapsed regex escapes reached the model',
  },
  {
    id: 'grep-braces-escaped',
    where: GREP,
    mustContain: 'interface\\{\\}',
    why: 'ripgrep brace escaping lost — model told the wrong pattern syntax',
  },
  {
    id: 'grep-braces-not-raw',
    where: GREP,
    mustNotContain: 'interface{}',
    why: 'unescaped braces mean the escape pass did not run on this site',
  },
];

const overrideDeliveryCanaries = [
  {
    id: 'grep-fff-backend-note',
    where: GREP,
    mustContain: 'Search backend note (fff)',
    why: 'our Grep override did not reach the wire at all',
  },
];

// Applies to every row: an override placeholder that failed to resolve arrives
// as a literal ALLCAPS `${NAME}`. Code samples inside tool descriptions
// legitimately contain lowercase `${d.key}`, so the ALLCAPS shape is what
// separates our identifier names from a model-facing JS example.
const placeholderLeakCanaries = [
  {
    id: 'no-allcaps-placeholder-leak',
    where: 'all',
    mustNotMatch: '\\$\\{[A-Z][A-Z0-9_]{2,}\\}',
    why: 'an override placeholder reached the model unresolved',
  },
  {
    id: 'no-unresolved-placeholder-notice',
    where: 'all',
    mustNotContain: 'Unresolved placeholder',
    why: 'the patcher leak guard fired and shipped its own notice',
  },
];

export const SELECTOR_ROWS = [
  {
    id: 'default-print-lean',
    enabled: true,
    verified: true,
    summary: 'print mode, no steer, no fork, lean gate (opus-4-8)',
    selectors: {
      dn: 'print',
      I6: 'default',
      d_e: 'default',
      oa: 'default',
      OS: 'lean',
      ADs: 'default',
    },
    // Grep and Glob are dropped from the tool set on non-Windows unless
    // `searchToolsOptIn` is set, and the only CLI route to that flag is naming
    // them in --allowedTools. Without this the Grep canaries would silently
    // assert against a tool that is never sent.
    args: ['--allowedTools=Grep,Glob'],
    env: {},
    canaries: [
      ...grepBackslashCanaries,
      ...overrideDeliveryCanaries,
      ...placeholderLeakCanaries,
    ],
  },
  {
    id: 'full-tooldesc-non-lean',
    enabled: false,
    verified: false,
    summary: 'non-lean gate — the verbose Grep description variant',
    selectors: {
      dn: 'print',
      I6: 'default',
      d_e: 'default',
      oa: 'default',
      OS: 'verbose',
      ADs: 'default',
    },
    args: ['--allowedTools=Grep,Glob'],
    env: {},
    canaries: [
      {
        id: 'grep-multiline-char-class',
        where: GREP,
        mustContain: '[\\s\\S]',
        why: 'a literal [sS] means backslashes were eaten at a backtick site',
      },
      {
        id: 'grep-multiline-char-class-not-eaten',
        where: GREP,
        mustNotContain: '[sS]',
        why: 'collapsed character class reached the model',
      },
      ...placeholderLeakCanaries,
    ],
  },
  {
    id: 'background-session',
    enabled: false,
    verified: false,
    summary: 'background job — system-prompt-background-session-instructions',
    selectors: {
      dn: 'print',
      I6: 'default',
      d_e: 'default',
      oa: 'default',
      OS: 'lean',
      ADs: 'default',
    },
    args: [],
    env: { CLAUDE_CODE_SESSION_KIND: 'bg' },
    canaries: [
      {
        id: 'background-job-dir-literal',
        where: 'system',
        mustContain: '$CLAUDE_JOB_DIR',
        why: 'the escaped literal collapsed into an interpolation',
      },
      {
        id: 'background-job-dir-not-interpolated',
        where: 'system',
        mustNotContain: '$e/tmp',
        why: 'a minified var resolved where the literal name belonged',
      },
      ...placeholderLeakCanaries,
    ],
  },
];

export const DEFAULT_ROW_ID = 'default-print-lean';

export const enabledRows = () => SELECTOR_ROWS.filter(r => r.enabled);

export const findRow = id => SELECTOR_ROWS.find(r => r.id === id);
