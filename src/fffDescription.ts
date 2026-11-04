export const FFF_FEATURE_TITLE =
  '[EXPERIMENTAL] native search and fff filename discovery';

export const FFF_FEATURE_DESCRIPTION =
  'Discover unknown project files with fff files in Bash, then inspect candidates. A short note in the final Bash tool description explains the workflow. Grep, Glob and normal Bash searches keep native behavior. Includes fuzzy @ suggestions, local filename ranking and optional learning from Bash file reads. History stays under ~/.tweakcc/fff.';

export const FFF_BASH_READ_TITLE = 'fff: learn from Bash file reads';

export const FFF_BASH_READ_DESCRIPTION =
  'Teach fff filename ranking from successful supported cat, head, tail, and single-file sed commands in Claude Code. Requires the native search and fff filename discovery integration; enabled by default. Preserves viewer output and status, and skips failed or ambiguous reads. Stores file paths and usage metadata locally. Absolute viewer paths, custom shell viewers, and stdin-only reads can bypass learning.';
