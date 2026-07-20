import chalk from 'chalk';
import { debug, stringifyRegex, verbose } from '../utils';
import { showDiff, PatchResult, PatchGroup } from './index';
import {
  loadSystemPromptsWithRegex,
  reconstructContentFromPieces,
  encodeReplacementForDelimiter,
  loadIdentifierMapUnion,
} from '../systemPromptSync';
import {
  delimiterBefore,
  detectUnicodeEscaping,
  extractBuildTime,
  pickMatchForSplice,
} from '../systemPromptSites';
import { setAppliedHashes, computeMD5Hash } from '../systemPromptHashIndex';
import { findAllMatchesWithStackFallback } from '../safeRegexMatch';

// The identifierMap union is polluted from two directions: old prompt JSONs
// named some slots after JS globals (`JSON`, from `${JSON.stringify(...)}` in
// the workflow-script prompts) and after raw minified vars (`U`, `G`, `P2`,
// `YU`, `HH8`). Neither is a tweakcc human-name. Once the leak detector stopped
// requiring a `}` right after the name, `${JSON.stringify(x)}` in a legitimate
// workflow-script override would match — so the detector must first ask whether
// the name is one tweakcc could have written.
const JS_GLOBAL_NAMES = new Set([
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'BigInt',
  'Error',
  'TypeError',
  'RangeError',
  'Infinity',
  'NaN',
  'undefined',
  'globalThis',
  'console',
  'process',
  'Buffer',
  'URL',
  'URLSearchParams',
  'Intl',
  'Reflect',
  'Proxy',
  'Function',
]);

/**
 * A tweakcc human-name is a descriptive placeholder the extractor generated
 * (`PROMPT_VAR_0`, `AGENT_TOOL_NAME`, `TOOL`). Reject JS globals and the short
 * minified identifiers (<= 3 chars) that leaked into older prompt JSONs, so the
 * leak detector never fires on real JS an override is allowed to contain.
 */
export const isTweakccHumanName = (name: string): boolean =>
  name.length > 3 && !JS_GLOBAL_NAMES.has(name);

/**
 * Result of applying system prompts
 */
export interface SystemPromptsResult {
  newContent: string;
  results: PatchResult[];
}

/**
 * Apply system prompt customizations to cli.js content
 * @param content - The current content of cli.js
 * @param version - The Claude Code version
 * @param escapeNonAscii - Whether to escape non-ASCII characters (auto-detected if not specified)
 * @param patchFilter - Optional list of patch/prompt IDs to apply (if provided, only matching prompts are applied)
 * @returns SystemPromptsResult with modified content and per-prompt results
 */
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
    // pickMatchForSplice keeps the sequential-consumption contract: when the
    // standalone filter can't narrow to one, index 0 is the next UNPATCHED site
    // of a multi-site prompt. Cardinality is verified up-front by the preflight.
    const { match, disambiguated } = pickMatchForSplice(content, allMatches);
    if (disambiguated) {
      debug(
        `Disambiguated ${allMatches.length} matches \u2192 1 standalone for "${prompt.name}"`
      );
    }

    if (match && match.index !== undefined) {
      // Generate the interpolated content using the actual variables from the match
      const interpolatedContent = getInterpolatedContent(match);

      // Check the delimiter character before the match to determine string type
      const matchIndex = match.index;
      const delimiter = delimiterBefore(content, matchIndex);

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
        // The name is captured wherever a `${...}` slot OPENS with it, not just
        // when a `}` follows: `${NAME.prop}`, `${NAME(arg)}` and
        // `${NAME.x||"y"}` are equally undefined identifiers inside a template
        // literal. Anchoring on `\}` missed exactly those — CC 2.1.206 shipped
        // `${SYSTEM_PROMPT_AGENT_RESUMED_WAS_STOPPED_COMPLETED_VAR_2.finalText
        // ||"(no text output)"}` into the binary because of it.
        const placeholderRe = /(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
        const inOutput = new Set(
          [...interpolatedContent.matchAll(placeholderRe)].map(m => m[1])
        );
        const leaked = [...inOutput].filter(
          name =>
            isTweakccHumanName(name) &&
            identifierMapUnion.has(name) &&
            new RegExp('(?<!\\\\)\\$\\{' + name + '(?![A-Za-z0-9_])').test(
              prompt.content
            )
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

      const encoded = encodeReplacementForDelimiter(
        interpolatedContent,
        delimiter,
        shouldEscapeNonAscii
      );
      if (encoded.incomplete) {
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
      if (encoded.autoEscaped) {
        // Successful auto-repair, not an actionable condition: the override
        // applies correctly. Keep it out of the apply log (0-warnings bar).
        debug(`Auto-escaped unescaped backticks in "${prompt.name}"`);
      }
      const replacementContent = encoded.content;

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
