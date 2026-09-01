import chalk from 'chalk';
import { debug, isVerbose, stringifyRegex, verbose } from '../utils';
import { showDiff, PatchResult, PatchGroup } from './index';
import {
  loadSystemPromptsWithRegex,
  reconstructContentFromPieces,
  encodeReplacementForDelimiter,
  needsDelimiterAwareEscaping,
} from '../systemPromptSync';
import {
  detectUnicodeEscaping,
  extractBuildTime,
  leakedPromptPlaceholders,
  selectSpliceSiteAt,
} from '../systemPromptSites';
import { setAppliedHashes, computeMD5Hash } from '../systemPromptHashIndex';
import { MutableText } from '../mutableText';
import {
  findAllPromptPieceMatches,
  foldPromptMatchContent,
  PromptPieceMatcherCatalog,
  PromptMatchSpec,
} from '../systemPromptPieceMatcher';

export { isTweakccHumanName } from '../systemPromptSites';

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
  const matchSpecs = new Map<string, PromptMatchSpec>();
  for (const entry of systemPrompts) {
    matchSpecs.set(entry.regex, {
      regex: entry.regex,
      pieces: entry.pieces,
      version,
      buildTime,
    });
  }
  const matchCatalog = new PromptPieceMatcherCatalog([...matchSpecs.values()]);
  matchCatalog.index(content, foldPromptMatchContent(content));
  const lastMatchUse = new Map<string, number>();
  systemPrompts.forEach((entry, index) => {
    lastMatchUse.set(entry.regex, index);
  });
  const expiringMatches = new Map<number, string[]>();
  for (const [regex, index] of lastMatchUse) {
    const current = expiringMatches.get(index);
    if (current) current.push(regex);
    else expiringMatches.set(index, [regex]);
  }
  const working = new MutableText(content);
  let contentChanged =
    pristineContent !== undefined && pristineContent !== content;

  // The set of every tweakcc human-name the leaf has ever used as a
  // placeholder, unioned across all bundled prompt JSONs. Used below to detect
  // a leaked (unsubstituted) human-name surviving into a backtick template
  // literal. Loaded once per apply.

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

  // Catalogue multiplicity per shape group, grouped by regex exactly as the
  // preflight groups it: several entries can share one regex, one per binary
  // site. `retained` counts the group's entries that resolved to a site and
  // left its bytes alone (uncustomized, or skipped by a guard) — those sites
  // still match, so the next entry has to index past them. `spliced` counts the
  // sites that are gone from the match list. See selectSpliceSiteAt.
  const groupMultiplicity = new Map<string, number>();
  for (const sp of systemPrompts) {
    if (patchFilter && !patchFilter.includes(sp.promptId)) continue;
    groupMultiplicity.set(sp.regex, (groupMultiplicity.get(sp.regex) ?? 0) + 1);
  }
  const groupRetained = new Map<string, number>();
  const groupSpliced = new Map<string, number>();

  // Track per-prompt results
  const results: PatchResult[] = [];
  const appliedHashUpdates: Record<string, string> = {};
  const hashResultIndexes: number[] = [];

  // Search for and replace each prompt in cli.js
  for (const [promptIndex, entry] of systemPrompts.entries()) {
    for (const expired of expiringMatches.get(promptIndex - 1) ?? []) {
      matchCatalog.delete(expired);
    }
    const {
      promptId,
      prompt,
      regex,
      getInterpolatedContent,
      pieces,
      identifiers,
      identifierMap,
    } = entry;
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
    // 's' for dotAll. No 'i': escapeNonAsciiForRegex already matches both hex
    // casings of a `\uXXXX` escape, and a case-insensitive prompt regex
    // over-matches its own prose (see foldPromptMatchContent).
    const pattern = new RegExp(regex, 's');

    // Some short prompts (e.g. tool-description-bash-git-never-skip-hooks) hold
    // text that Anthropic also inlines verbatim into a longer prompt
    // (PowerShell tool description). The first occurrence in cli.js is the
    // inlined one; the standalone variable lives later. Pick the match that
    // looks like a complete string-literal value (surrounded by matching
    // " ' or ` delimiters) when more than one occurrence exists.
    const allMatches = await matchCatalog.matchCurrent(regex, working);
    const multiplicity = groupMultiplicity.get(regex) ?? 1;
    const retained = groupRetained.get(regex) ?? 0;
    const remaining = multiplicity - (groupSpliced.get(regex) ?? 0);
    const { match, ambiguous, disambiguated } = selectSpliceSiteAt(
      allMatches,
      remaining,
      retained,
      index => working.charAt(index)
    );
    if (disambiguated) {
      debug(
        `Disambiguated ${allMatches.length} matches \u2192 ${remaining} standalone for "${prompt.name}"`
      );
    }

    if (ambiguous) {
      console.log(
        chalk.yellow(
          `"${prompt.name}" matches ${allMatches.length} places in cli.js for ${remaining} ` +
            'catalogue entr' +
            (remaining === 1 ? 'y' : 'ies') +
            ' and none of them is identifiable \u2014 skipping rather than ' +
            'splicing into whichever came first'
        )
      );
      results.push({
        id: promptId,
        name: prompt.name,
        group: PatchGroup.SYSTEM_PROMPTS,
        applied: false,
        details: `${allMatches.length} ambiguous candidate sites - no site attributable to this prompt`,
      });
      continue;
    }

    if (match && match.index !== undefined) {
      // reconstructContentFromPieces produced the .md body in the first place,
      // so an untouched file still equals it and there is nothing to apply.
      // Re-encoding it anyway is not safe: the .md is a hybrid of decoded
      // quotes and raw JavaScript escapes, so the escaping passes below are not
      // its inverse \u2014 they double a backslash that was already literal prompt
      // text and emit `\uXXXX` where the bundle had `\xHH` or an uppercase
      // escape, rewriting prompts nobody customized on every apply (#922).
      // Leaving the site untouched is both correct and the only form guaranteed
      // to survive the round trip. Compared trimmed because the markdown round
      // trip is only trim-stable: gray-matter normalises the trailing newline,
      // and applyOriginalWhitespace already treats the edges as serialization.
      const originalBaselineContent = reconstructContentFromPieces(
        pieces,
        identifiers,
        identifierMap
      ).trim();
      if (prompt.content.trim() === originalBaselineContent) {
        debug(
          `"${prompt.name}": still vanilla \u2014 leaving cli.js untouched`
        );
        groupRetained.set(regex, retained + 1);
        appliedHashUpdates[promptId] = computeMD5Hash(prompt.content);
        results.push({
          id: promptId,
          name: prompt.name,
          group: PatchGroup.SYSTEM_PROMPTS,
          applied: false,
          details: 'unchanged',
        });
        hashResultIndexes.push(results.length - 1);
        continue;
      }
      // Generate the interpolated content using the actual variables from the
      // match. `substituteInInterpolations` throws on a malformed `${` — an
      // unclosed brace, an apostrophe inside one, a comment — all of which are
      // plausible authored text ("cost is ${100 for a run"). Uncaught, that
      // propagated out of the whole apply as a bare stack trace naming no
      // prompt, on native AFTER the extract step. Catch it here, where the id
      // is known, and skip only the offending override.
      let interpolatedContent: string;
      try {
        interpolatedContent = getInterpolatedContent(match);
      } catch (error) {
        console.log(
          chalk.red(
            `Malformed \${...} interpolation in "${prompt.name}" (${promptId}.md): ` +
              `${error instanceof Error ? error.message : String(error)} - skipping`
          )
        );
        groupRetained.set(regex, retained + 1);
        results.push({
          id: promptId,
          name: prompt.name,
          group: PatchGroup.SYSTEM_PROMPTS,
          applied: false,
          failed: true,
          details: 'malformed ${...} interpolation in the markdown',
        });
        continue;
      }

      // Check the delimiter character before the match to determine string type
      const matchIndex = match.index;
      const delimiter = working.charAt(matchIndex - 1);

      // Guard: a tweakcc human-name placeholder that survives interpolation.
      // Substitution rewrites every name the prompt's identifierMap knows into
      // its minified identifier; one that survives is a name the map no
      // longer has — the vocabulary moved between CC versions (a renamed slot,
      // a slot that left, a catalogue entry that lost its interpolations). The
      // detector reads the WHOLE `${…}` expression, not just its first token:
      // CC 2.1.257 shipped `${e!==null?OUTPUT_STYLE_AGENT_INTRO_FN():…}` into
      // the lean system-prompt builder past a first-token check, and every
      // interactive turn then ended on a swallowed ReferenceError.
      //
      // Inside a backtick template literal the survivor is invalid JS. Inside
      // a '…'/"…" string it is inert JS but still WRONG: the model reads
      // `${…_VAR_0?\`If the user asks…` as prose (the Artifact description on
      // 2.1.257 rendered exactly that). The only legitimate survivor is a
      // literal the pristine text itself carries (`${VERSION}` in the
      // data-anthropic-cli docs) — pass-through of Anthropic's own text.
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
        const leaked = leakedPromptPlaceholders(
          interpolatedContent,
          prompt.content
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
          groupRetained.set(regex, retained + 1);
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
        // can): genuine vocabulary drift. Skip loudly — unless every survivor
        // is a literal the pristine span carries verbatim, which is Anthropic's
        // own text passing through (data-anthropic-cli's `${VERSION}`).
        // In a backtick host every survivor is live code, so nothing passes.
        const pristineSpan = match[0];
        const driftedNames =
          delimiter === '`'
            ? leaked
            : leaked.filter(
                name =>
                  !new RegExp(
                    '(?<!\\\\)\\$\\{' + name + '(?![A-Za-z0-9_])'
                  ).test(pristineSpan)
              );
        if (driftedNames.length > 0) {
          leaked.splice(0, leaked.length, ...driftedNames);
          console.log(
            chalk.red(
              `Unresolved placeholder \${${leaked[0]}} in "${prompt.name}" (markdown vocabulary out of sync with CC ${version} prompt data) - skipping`
            )
          );
          groupRetained.set(regex, retained + 1);
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

      // Guard: the delimiter is read from the single character before the
      // match, which only names the enclosing literal when the match IS the
      // whole literal value. At a site that is a fragment of a longer literal
      // that character is arbitrary and encodeReplacementForDelimiter has no
      // branch for it, so the body would be embedded with no escaping at all —
      // one raw backtick or `${` there terminates a template literal early and
      // leaves the rest of cli.js as floating syntax ("Expected CommonJS module
      // to have a function wrapper" at launch). Text that needs no
      // delimiter-specific escaping is inert in any of the three literal kinds
      // and still applies.
      if (
        delimiter !== '"' &&
        delimiter !== "'" &&
        delimiter !== '`' &&
        needsDelimiterAwareEscaping(interpolatedContent)
      ) {
        console.log(
          chalk.yellow(
            `"${prompt.name}" resolves inside a larger string literal (no delimiter at the ` +
              'match boundary) and its content needs delimiter-specific escaping - skipping'
          )
        );
        groupRetained.set(regex, retained + 1);
        results.push({
          id: promptId,
          name: prompt.name,
          group: PatchGroup.SYSTEM_PROMPTS,
          applied: false,
          details:
            'unresolvable string delimiter - cannot escape content safely',
        });
        continue;
      }

      // Calculate character counts for this prompt (both with human-readable placeholders)
      // Note: trim() to match how markdown files are parsed and how whitespace is applied
      const originalLength = originalBaselineContent.length;
      const newLength = prompt.content.trim().length;

      const verboseOldContent = isVerbose() ? working.toString() : null;
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
        groupRetained.set(regex, retained + 1);
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
      if (replacementContent !== match[0]) {
        groupSpliced.set(regex, (groupSpliced.get(regex) ?? 0) + 1);
        working.splice(
          matchIndex,
          matchIndex + matchLength,
          replacementContent
        );
        contentChanged = true;
        matchCatalog.recordSplice(working, {
          start: matchIndex,
          end: matchIndex + matchLength,
          replacementLength: replacementContent.length,
        });
      } else {
        // Same bytes: the site keeps matching, so the group's next entry must
        // index past it rather than resolve to it again.
        groupRetained.set(regex, retained + 1);
      }

      // Store the hash of the applied prompt content
      const appliedHash = computeMD5Hash(prompt.content);
      appliedHashUpdates[promptId] = appliedHash;

      // Show diff in debug mode
      if (verboseOldContent !== null) {
        showDiff(
          verboseOldContent,
          working.toString(),
          replacementContent,
          matchIndex,
          matchIndex + matchLength
        );
      }

      // Track this prompt's result
      const charDiff = originalLength - newLength;
      const applied = replacementContent !== match[0];

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
      if (pristineContent !== undefined && contentChanged) {
        try {
          const spec = matchSpecs.get(regex);
          const matchedPristine = spec
            ? await findAllPromptPieceMatches(spec, pristineContent)
            : [];
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

      if (isVerbose()) {
        verbose(`\n  Debug info for ${prompt.name}:`);
        verbose(
          `  Regex pattern (first 200 chars): ${regex.substring(0, 200).replace(/\n/g, '\\n')}...`
        );
        verbose(`  Trying to match pattern in cli.js...`);
        try {
          const testMatch = working
            .toString()
            .match(new RegExp(regex.substring(0, 100)));
          verbose(
            `  Partial match result: ${testMatch ? 'found partial' : 'no match'}`
          );
        } catch {
          verbose(`  Partial match failed (regex truncation issue)`);
        }
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
    newContent: working.toString(),
    results,
  };
};
