import chalk from 'chalk';
import { debug, stringifyRegex, verbose } from '../utils';
import { showDiff, PatchResult, PatchGroup } from './index';
import {
  loadSystemPromptsWithRegex,
  reconstructContentFromPieces,
  escapeDepthZeroBackticks,
  escapeNonAsciiChars,
  loadIdentifierMapUnion,
} from '../systemPromptSync';
import { setAppliedHashes, computeMD5Hash } from '../systemPromptHashIndex';
import { findAllMatchesWithStackFallback } from '../safeRegexMatch';

/**
 * Result of applying system prompts
 */
export interface SystemPromptsResult {
  newContent: string;
  results: PatchResult[];
}

/**
 * Detects if the cli.js file uses Unicode escape sequences for non-ASCII characters.
 * This is common in Bun native executables.
 */
const detectUnicodeEscaping = (content: string): boolean => {
  // Look for Unicode escape sequences like \u2026 in string literals
  // We'll check for a pattern that suggests intentional escaping of common non-ASCII chars
  const unicodeEscapePattern = /\\u[0-9a-fA-F]{4}/;
  return unicodeEscapePattern.test(content);
};

/**
 * Extracts the BUILD_TIME value from cli.js content.
 * BUILD_TIME is an ISO 8601 timestamp like "2025-12-09T19:43:43Z"
 */
const extractBuildTime = (content: string): string | undefined => {
  const match = content.match(
    /\bBUILD_TIME:"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/
  );
  return match ? match[1] : undefined;
};

/**
 * Apply system prompt customizations to cli.js content
 * @param content - The current content of cli.js
 * @param version - The Claude Code version
 * @param escapeNonAscii - Whether to escape non-ASCII characters (auto-detected if not specified)
 * @param patchFilter - Optional list of patch/prompt IDs to apply (if provided, only matching prompts are applied)
 * @returns SystemPromptsResult with modified content and per-prompt results
 */
const escapeUnescapedChar = (str: string, char: string): string => {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') {
        bs++;
        j--;
      }
      if (bs % 2 === 0) {
        result += '\\' + char;
      } else {
        result += char;
      }
    } else {
      result += str[i];
    }
  }
  return result;
};

export const applySystemPrompts = async (
  content: string,
  version: string,
  escapeNonAscii?: boolean,
  patchFilter?: string[] | null,
  // The binary as it was BEFORE any override splicing (inline-blob, reminders).
  // Lets us distinguish a prompt clobbered by tweakcc's own earlier splice
  // (matched the pristine binary but not the current one → silent skip) from
  // genuine anchor drift (never matched the pristine binary → warn). When
  // omitted, every non-match is treated as drift (pre-existing behavior).
  pristineContent?: string
): Promise<SystemPromptsResult> => {
  // Auto-detect if we should escape non-ASCII characters based on cli.js content
  const shouldEscapeNonAscii = escapeNonAscii ?? detectUnicodeEscaping(content);

  if (shouldEscapeNonAscii) {
    debug(
      'Detected Unicode escaping in cli.js - will escape non-ASCII characters in prompts'
    );
  }

  // Extract BUILD_TIME from cli.js content
  const buildTime = extractBuildTime(content);
  if (buildTime) {
    debug(`Extracted BUILD_TIME from cli.js: ${buildTime}`);
  }

  // Load system prompts and generate regexes
  const systemPrompts = await loadSystemPromptsWithRegex(
    version,
    shouldEscapeNonAscii,
    buildTime
  );
  debug(`Loaded ${systemPrompts.length} system prompts with regexes`);

  // The set of every tweakcc human-name the leaf has ever used as a
  // placeholder, unioned across all bundled prompt JSONs. Used below to detect
  // a leaked (unsubstituted) human-name surviving into a backtick template
  // literal. Loaded once per apply.
  const identifierMapUnion = await loadIdentifierMapUnion();

  // Per-id union of identifierMap names across same-id entries. A prompt that
  // exists at multiple code-sites yields one entry per site sharing one id and
  // one .md; when the sites have different shapes (e.g. a template wrapper vs
  // plain string copies), an .md authored against the richer shape carries
  // placeholders the plain entries cannot resolve — injecting it there writes
  // the placeholder names as literal text into the binary (silent content
  // corruption; quote contexts never crash). Used below to skip those sites.
  const groupNames = new Map<string, Set<string>>();
  for (const sp of systemPrompts) {
    let names = groupNames.get(sp.promptId);
    if (!names) {
      names = new Set();
      groupNames.set(sp.promptId, names);
    }
    for (const v of Object.values(sp.identifierMap)) names.add(v);
  }

  // Track per-prompt results
  const results: PatchResult[] = [];
  const appliedHashUpdates: Record<string, string> = {};
  const hashResultIndexes: number[] = [];

  // Search for and replace each prompt in cli.js
  for (const {
    promptId,
    prompt,
    regex,
    getInterpolatedContent,
    pieces,
    identifiers,
    identifierMap,
  } of systemPrompts) {
    // Skip prompts not in the filter (if filter is provided)
    if (patchFilter && !patchFilter.includes(promptId)) {
      results.push({
        id: promptId,
        name: prompt.name,
        group: PatchGroup.SYSTEM_PROMPTS,
        applied: false,
        skipped: true,
      });
      continue;
    }

    debug(`Applying system prompt: ${prompt.name}`);
    const pattern = new RegExp(regex, 'si'); // 's' flag for dotAll mode, 'i' because of casing inconsistencies in unicode escape sequences (e.g. `\u201C` in the regex vs `\u201C` in the file)

    // Some short prompts (e.g. tool-description-bash-git-never-skip-hooks) hold
    // text that Anthropic also inlines verbatim into a longer prompt
    // (PowerShell tool description). The first occurrence in cli.js is the
    // inlined one; the standalone variable lives later. Pick the match that
    // looks like a complete string-literal value (surrounded by matching
    // " ' or ` delimiters) when more than one occurrence exists.
    const allMatches = await findAllMatchesWithStackFallback(
      regex,
      'sig',
      content
    );
    let match: RegExpMatchArray | RegExpExecArray | null = null;
    if (allMatches.length === 1) {
      match = allMatches[0];
    } else if (allMatches.length > 1) {
      const isDelim = (c: string) => c === '"' || c === "'" || c === '`';
      const standalone = allMatches.filter(m => {
        const before = m.index > 0 ? content[m.index - 1] : '';
        const after = content[m.index + m[0].length] ?? '';
        return isDelim(before) && before === after;
      });
      if (standalone.length === 1) {
        match = standalone[0];
        debug(
          `Disambiguated ${allMatches.length} matches \u2192 1 standalone for "${prompt.name}"`
        );
      } else {
        match = allMatches[0];
      }
    }

    if (match && match.index !== undefined) {
      // Generate the interpolated content using the actual variables from the match
      const interpolatedContent = getInterpolatedContent(match);

      // Check the delimiter character before the match to determine string type
      const matchIndex = match.index;
      const delimiter = matchIndex > 0 ? content[matchIndex - 1] : '';

      // Guard: a tweakcc human-name placeholder that survives interpolation into
      // a `${...}` template-literal slot is invalid JS and ReferenceErrors at
      // launch (or when the prompt's code path first runs). This happens when the
      // prompt-data identifierMap vocabulary changed between CC versions (e.g.
      // PROMPT_VAR_N -> *_TOOL_NAME at 2.1.168, or a renamed semantic name like
      // OPTIONAL_TAIL_NOTE) while the markdown still references the old name, so
      // applyIdentifierMapping finds nothing to substitute and leaves the
      // placeholder verbatim. Detect a surviving `${NAME}` whose NAME is a member
      // of the identifierMap union (the set of every human-name the leaf has ever
      // used as a placeholder) and that appears unchanged in BOTH the markdown
      // source and the interpolated output. Validating against the union -- rather
      // than guessing an ALL_CAPS_WITH_UNDERSCORE grammar -- catches single-word
      // names like ${VERSION} the grammar missed and never false-positives on real
      // minified vars (e.g. `${HL7}`), which are never human-names. Only dangerous
      // inside backtick template literals; the same token in a plain '...'/"..."
      // string is inert. Skip the prompt and keep CC's original blob rather than
      // shipping a binary that won't boot.
      {
        // Only UNescaped `${NAME}` is dangerous: a backslash-escaped
        // `\${NAME}` is intentional literal text (e.g. the env-var docs
        // `\${CLAUDE_PLUGIN_ROOT}` in the cowork plugin prompts, which have an
        // empty identifierMap) and survives into the template literal verbatim.
        // The negative lookbehind excludes those so they aren't false-flagged.
        const placeholderRe = /(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
        const inOutput = new Set(
          [...interpolatedContent.matchAll(placeholderRe)].map(m => m[1])
        );
        const leaked = [...inOutput].filter(
          name =>
            identifierMapUnion.has(name) &&
            new RegExp('(?<!\\\\)\\$\\{' + name + '\\}').test(prompt.content)
        );

        // Every leaked name resolvable by a same-id sibling entry (and none by
        // this one) means the .md is authored against a different shape of
        // this multi-site prompt. Expected per-site situation, not drift:
        // leave this site pristine, quietly.
        const ownNames = new Set(Object.values(identifierMap));
        const siblingNames = groupNames.get(promptId);
        if (
          leaked.length > 0 &&
          leaked.every(n => !ownNames.has(n) && siblingNames?.has(n))
        ) {
          debug(
            `"${prompt.name}": placeholders resolve via a same-id sibling shape — leaving this site pristine`
          );
          results.push({
            id: promptId,
            name: prompt.name,
            group: PatchGroup.SYSTEM_PROMPTS,
            applied: false,
            skipped: true,
          });
          continue;
        }

        // A leaked name this entry should have resolved (or that no sibling
        // can): genuine vocabulary drift. Inside a backtick template literal
        // it is invalid JS that ReferenceErrors at launch — skip loudly. In
        // '…'/"…" strings the same token is inert text and can be intentional
        // (e.g. data-anthropic-cli's literal ${VERSION}), so it passes through
        // unchanged there.
        if (delimiter === '`' && leaked.length > 0) {
          console.log(
            chalk.red(
              `Unresolved placeholder \${${leaked[0]}} in "${prompt.name}" (markdown vocabulary out of sync with CC ${version} prompt data) - skipping`
            )
          );
          results.push({
            id: promptId,
            name: prompt.name,
            group: PatchGroup.SYSTEM_PROMPTS,
            applied: false,
            details: `unresolved placeholder \${${leaked[0]}} - markdown out of sync with prompt data`,
          });
          continue;
        }
      }

      // Calculate character counts for this prompt (both with human-readable placeholders)
      // Note: trim() to match how markdown files are parsed and how whitespace is applied
      const originalBaselineContent = reconstructContentFromPieces(
        pieces,
        identifiers,
        identifierMap
      ).trim();
      const originalLength = originalBaselineContent.length;
      const newLength = prompt.content.trim().length;

      const oldContent = content;
      const matchLength = match[0].length;

      let replacementContent = interpolatedContent;

      // Escape literal backslashes FIRST so they survive JS string
      // embedding. Without this, a markdown `\"user\"` ends up as `"user"`
      // because the backslash is consumed as an escape character. (#660)
      // Backticks are excluded: escapeDepthZeroBackticks already uses a
      // parity-aware algorithm that treats preceding backslashes correctly,
      // so pre-doubling breaks `\`` sequences (which become `\\` + closing
      // backtick in a template literal, terminating the template early).
      if (delimiter === '"' || delimiter === "'") {
        replacementContent = replacementContent.replace(/\\/g, '\\\\');
      }

      if (delimiter === '"') {
        replacementContent = replacementContent.replace(/\r\n|\r|\n/g, '\\n');
        replacementContent = escapeUnescapedChar(replacementContent, '"');
      } else if (delimiter === "'") {
        replacementContent = replacementContent.replace(/\r\n|\r|\n/g, '\\n');
        replacementContent = escapeUnescapedChar(replacementContent, "'");
      } else if (delimiter === '`') {
        replacementContent = replacementContent.replace(/\r\n|\r/g, '\n');
        const { content: escaped, incomplete } =
          escapeDepthZeroBackticks(replacementContent);
        if (incomplete) {
          console.log(
            chalk.red(
              `Incomplete backtick escaping for "${prompt.name}" (unclosed interpolation) - skipping`
            )
          );
          results.push({
            id: promptId,
            name: prompt.name,
            group: PatchGroup.SYSTEM_PROMPTS,
            applied: false,
            details: 'incomplete escaping: unclosed interpolation detected',
          });
          continue;
        }
        if (escaped !== replacementContent) {
          console.log(
            chalk.yellow(`Auto-escaped unescaped backticks in "${prompt.name}"`)
          );
        }
        replacementContent = escaped;
      }

      // Non-ASCII → \uXXXX last, AFTER the backslash-doubling above — doubling
      // an already-escaped `—` ships literal `\\u2014` text to the model
      // (silent corruption at every quote-context site with an em-dash).
      if (shouldEscapeNonAscii) {
        replacementContent = escapeNonAsciiChars(replacementContent);
      }

      // Replace the matched content with the interpolated content from the markdown file.
      // Splice at the match offset (rather than `content.replace(pattern, fn)`)
      // so the disambiguation above isn't undone by replace() always matching
      // the first hit.
      content =
        content.slice(0, matchIndex) +
        replacementContent +
        content.slice(matchIndex + matchLength);

      // Store the hash of the applied prompt content
      const appliedHash = computeMD5Hash(prompt.content);
      appliedHashUpdates[promptId] = appliedHash;

      // Show diff in debug mode
      showDiff(
        oldContent,
        content,
        replacementContent,
        matchIndex,
        matchIndex + matchLength
      );

      // Track this prompt's result
      const charDiff = originalLength - newLength;
      const applied = oldContent !== content;

      let details: string;
      if (charDiff > 0) {
        details = chalk.green(`${charDiff} fewer chars`);
      } else if (charDiff < 0) {
        details = chalk.red(`${Math.abs(charDiff)} more chars`);
      } else {
        details = 'unchanged';
      }

      const resultIndex = results.length;
      results.push({
        id: promptId,
        name: prompt.name,
        group: PatchGroup.SYSTEM_PROMPTS,
        applied,
        details,
      });
      hashResultIndexes.push(resultIndex);
    } else {
      // Shadowed prompts (owned by inline-blob, system-reminders, or a wider
      // named-prompt) are filtered upstream in loadSystemPromptsWithRegex via
      // the `shadows:` frontmatter on the owning override.
      //
      // A prompt can also be shadowed implicitly: its text lives inside a
      // region an inline-blob/reminder override already replaced this apply
      // (e.g. a "## Types of memory" array element, a "# System" bullet). The
      // override author may not have enumerated every named id its region
      // consumes. Detect this by re-matching against the pristine snapshot:
      // if the regex matched the binary BEFORE any splicing but not now, our
      // own earlier override clobbered it — its curated content was
      // intentionally superseded, so skip silently (no drift warning, no
      // spurious "Could not find"). Only a prompt that matched neither the
      // pristine nor the current binary is genuine anchor drift worth
      // surfacing.
      let clobberedByEarlierSplice = false;
      if (pristineContent !== undefined && pristineContent !== content) {
        try {
          const matchedPristine = await findAllMatchesWithStackFallback(
            regex,
            'sig',
            pristineContent
          );
          clobberedByEarlierSplice = matchedPristine.length > 0;
        } catch {
          clobberedByEarlierSplice = false;
        }
      }

      if (clobberedByEarlierSplice) {
        debug(
          `"${prompt.name}": region consumed by an earlier inline-blob/reminder override — leaving superseded, no warning`
        );
        results.push({
          id: promptId,
          name: prompt.name,
          group: PatchGroup.SYSTEM_PROMPTS,
          applied: false,
          skipped: true,
        });
        continue;
      }

      // Genuine drift — a regex anchor that no longer matches the binary
      // shape. Surface it so the owning override can be fixed.
      if (
        !prompt.name.startsWith('Data:') &&
        prompt.name !== 'Skill: Build with Claude API'
      ) {
        console.log(
          chalk.yellow(
            `Could not find system prompt "${prompt.name}" in cli.js (using regex ${stringifyRegex(pattern)})`
          )
        );
      }

      verbose(`\n  Debug info for ${prompt.name}:`);
      verbose(
        `  Regex pattern (first 200 chars): ${regex.substring(0, 200).replace(/\n/g, '\\n')}...`
      );
      verbose(`  Trying to match pattern in cli.js...`);
      try {
        const testMatch = content.match(new RegExp(regex.substring(0, 100)));
        verbose(
          `  Partial match result: ${testMatch ? 'found partial' : 'no match'}`
        );
      } catch {
        verbose(`  Partial match failed (regex truncation issue)`);
      }
    }
  }

  try {
    await setAppliedHashes(appliedHashUpdates);
  } catch (error) {
    debug(`Failed to store applied prompt hashes: ${error}`);
    for (const index of hashResultIndexes) {
      const result = results[index];
      if (!result) continue;
      result.failed = true;
      result.details = result.details
        ? `${result.details} (hash storage failed)`
        : 'hash storage failed';
    }
  }

  return {
    newContent: content,
    results,
  };
};
