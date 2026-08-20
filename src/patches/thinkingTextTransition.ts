/**
 * Patch for v234 (and similar versions): Gracefully handle text blocks receiving thinking deltas.
 *
 * In v234's streaming response handler, the `signature_delta` and `thinking_delta`
 * cases throw "Content block is not a thinking block" when ni.type !== "thinking".
 * This happens during thinking-to-text transitions (the LLM finishes reasoning
 * mid-stream). All versions from v233+ share this pattern.
 *
 * Fix: Inject `if(ni.type==="text"){Cn=!0;break}` before each throw to gracefully
 * skip the delta and transition to text mode for this turn, then re-enable thinking
 * on the next turn when a new content_block_start arrives.
 *
 * Uses the LexPatcher engine — variable names (O, Ce/ge/blockTypeVar/moreThinkingFlag) are extracted via
 * structural regex matchers in bounded context windows, so it survives per-release
 * minification/obfuscation across v233/v234/v235+.
 */

import { LexPatcher } from './lexPatcher.js';
import type { LexPatcherConfig } from './lexPatcher.js';

// ===========================================================================
// Thinking-to-text transition patch configuration for the LexPatcher engine.
// ===========================================================================

/** Extract O, Ce/x, ge/me, blockTypeVar, moreThinkingFlag from v23x source */
const thinkingTextTransitionConfig: LexPatcherConfig = {
  // sigDelta anchor matches `case"signature_delta":if(` — unique throw-based handler pattern.
  // contextWindowBefore of 4000 chars reaches content_block_delta (moreThinkingFlag init) and text_delta (blockTypeVar detection).
  anchors: [
    {
      id: 'sigDelta',
      regex: /case"signature_delta":if\(/,
      contextWindowBefore: 4000,
      contextWindowAfter: 3000, // reaches thinking_delta case
      searchExtensionAfterMatch: 60, // throw O("tengu_streaming_error") starts ~30 chars after anchor end, pattern extends to ~55
    },
    // Anchor for the thinking_delta injection: matches `redacted_thinking")break;` which is unique per file.
    // Injecting after this places the text-check between the redacted_thinking guard and the throw condition.
    {
      id: 'thinkDelta',
      regex: /"redacted_thinking"\)break;/,
      contextWindowBefore: 3000,
      contextWindowAfter: 1500,
    },
  ],

  // Variables extracted from the signature_delta anchor's wide context window.
  variables: [
    /** O — error factory function used in throw statements (e.g., `throw O("tengu_streaming_error"`) */
    {
      id: 'O',
      anchorId: 'sigDelta',
      direction: 'before',
      regex: /throw (\w+)\("tengu_streaming_error"/,
    },
    /** Ce/x — content block type mapper used in error_type (e.g., `error_type:Ce(` or `error_type:xe(`) */
    {
      id: 'contentMapper',
      anchorId: 'sigDelta',
      direction: 'before',
      regex: /error_type:(\w+)\("content_block_type_mismatch/,
    },
    /** ge/me — actual type getter used in `actual_type:ge(` or `actual_type:me(` */
    {
      id: 'typeGetter',
      anchorId: 'sigDelta',
      direction: 'before',
      regex: /actual_type:(\w+)\([^)]+\.type/,
    },
    /** blockTypeVar — the variable used for content type checks in text_delta (e.g., `if(ni.type!=="text")` or `if(Al.type!=="text")`) */
    {
      id: 'blockTypeVar',
      anchorId: 'sigDelta',
      direction: 'before',
      regex: /if\((\w+)\.type!=="text"\)/,
    },
    /** moreThinkingFlag — the "no more thinking" flag (e.g., `Cn=!1` or `to=!1`) set in content_block_delta handler */
    {
      id: 'moreThinkingFlag',
      anchorId: 'sigDelta',
      direction: 'before',
      regex: /content_block_delta.{0,5}:\{(\w+)=!1/,
    },
  ],

  // Inject text-mode skip block at two positions.
  injections: [
    // sigDelta injection: after `case"signature_delta":if(` → lands right before the type check condition
    {
      targetAnchorId: 'sigDelta',
      position: 'after',
      template: vars => {
        const bt = vars.blockTypeVar || '';
        const mf = vars.moreThinkingFlag || '';

        if (!bt || !mf) return ''; // skip if variables not found

        return `{if(${bt}.type==="text"){${mf}=!0;break};`;
      },
    },
    // thinkDelta injection: after `redacted_thinking")break;` → lands right before the throw condition
    {
      targetAnchorId: 'thinkDelta',
      position: 'after',
      template: vars => {
        const bt = vars.blockTypeVar || '';
        const mf = vars.moreThinkingFlag || '';

        if (!bt || !mf) return ''; // skip if variables not found

        return `{if(${bt}.type==="text"){${mf}=!0;break};`;
      },
    },
  ],
};

/** Build idempotency check regex from captured variable names */
function buildIdempotentRe(blockType: string, moreThinking: string): RegExp {
  return new RegExp(
    `${blockType}\\.type==="text"\\)\\{${moreThinking}=!0`,
    'g'
  );
}

/**
 * Extract the block-type-check variable name that LexPatcher uses for text-check injections.
 * Searches only within the sigDelta anchor's context window (4000 chars before),
 * so we don't accidentally match a different variable at an earlier position in the file.
 */
function extractBlockTypeVar(source: string): string | null {
  const sigAnchor = /case"signature_delta":if\(/;
  const m = sigAnchor.exec(source);
  if (!m || m.index === undefined) return null;

  // Search within the full context window LexPatcher uses (before anchor + match text itself)
  const contextStart = Math.max(0, m.index - 4000);
  const contextWindow = source.substring(contextStart, m.index + m[0].length);

  const re = /if\((\w+)\.type!=="text"\)/;
  const match = re.exec(contextWindow);
  return match ? match[1] : null;
}

/**
 * Extract the "more thinking" flag variable name from within the
 * sigDelta anchor's context window (near content_block_delta).
 */
function extractMoreThinkingFlag(source: string): string | null {
  const sigAnchor = /case"signature_delta":if\(/;
  const m = sigAnchor.exec(source);
  if (!m || m.index === undefined) return null;

  const contextStart = Math.max(0, m.index - 4000);
  const contextWindow = source.substring(contextStart, m.index + m[0].length);

  const cnRe = /content_block_delta.{0,5}:\{(\w+)=!1/;
  const match = cnRe.exec(contextWindow);
  return match ? match[1] : null;
}

/**
 * Apply the thinking-to-text graceful transition patch to minified source.
 * Uses LexPatcher engine for version-agnostic variable extraction.
 * Returns patched source or null if anchors not found (not patchable, already patched).
 */
export function applyThinkingTextTransition(oldFile: string): string | null {
  const patcher = new LexPatcher(thinkingTextTransitionConfig);
  const result = patcher.apply(oldFile);

  if (!result) {
    console.log('patch: thinkingTextTransition: anchors not found — skipping');
    return null;
  }

  // Extract variable names scoped to sigDelta's context window so we match the
  // same variables LexPatcher used (not a different one at an earlier position).
  const blockTypeVar = extractBlockTypeVar(oldFile);
  const moreThinkingFlag = extractMoreThinkingFlag(oldFile);

  if (!blockTypeVar || !moreThinkingFlag) {
    console.log(
      'patch: thinkingTextTransition: variable extraction failed — skipping'
    );
    return null;
  }

  // Check idempotency: count existing text-check injections in original source
  const idemRe = buildIdempotentRe(blockTypeVar, moreThinkingFlag);
  const textCheckCount = oldFile.match(idemRe);

  if (textCheckCount && textCheckCount.length >= 2) {
    console.log('patch: thinkingTextTransition: already patched, skipping');
    return null;
  }

  // Verify the injections were actually applied by counting them in result
  const newTextChecks = result.match(idemRe);
  if (!newTextChecks || newTextChecks.length < 2) {
    console.error(
      `patch: thinkingTextTransition: expected 2 text-check injections, got ${newTextChecks?.length ?? 0}`
    );
    return null;
  }

  const O = oldFile.match(/throw (\w+)\("tengu_streaming_error"/)?.[1] || 'O';
  const contentMapper = oldFile.match(
    /error_type:(\w+)\("content_block_type_mismatch/
  )?.[1];
  const typeGetter = oldFile.match(/actual_type:(\w+)\([^)]+\.type/)?.[1];

  console.log(
    `patch: thinkingTextTransition: applied (errorFactory=${O}, contentMapper=${contentMapper}, typeGetter=${typeGetter}, blockTypeVar=${blockTypeVar}, moreThinkingFlag=${moreThinkingFlag})`
  );

  return result;
}
