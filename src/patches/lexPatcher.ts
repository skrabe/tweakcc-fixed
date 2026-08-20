/**
 * Generic LEX Walker Patch Engine for Claude Code minified JS.
 *
 * ## Overview
 *
 * Claude Code ships as heavily minified JavaScript where variable/function names
 * change between versions (e.g. `G9t` vs `Q6t`). This engine walks the source
 * lexically — finding stable structural anchors, extracting per-version variable
 * names via regex matchers in bounded context windows, and injecting new code
 * with safe non-colliding names.
 *
 * ## Core rule: NEVER hardcode user-variable names
 *
 * **Always** write matchers that capture whatever the minifier chose — do NOT
 * embed literal variable/function names from a specific version's source. The
 * config object (`variables` array) is populated at runtime by regex matchers,
 * and injection `template()` functions reference those via `vars.<id>`.
 *
 * ### Wrong (fragile to minifier changes):
 * ```ts
 * // ❌ Hardcodes 'ni', 's', 'a' — breaks when the minifier renames them
 * const step2Re = /if\(ni\.type!=="thinking"\)throw/;
 * funcContent = funcContent.replace(step2Re, `if(${name}.type==="text"){${flag}=!0;break};`);
 * ```
 *
 * ### Right (survives any minifier rename):
 * ```ts
 * // ✅ Matcher captures the actual variable name from source; template uses it
 * variables: [{ id: 'blockTypeVar', anchorId: 'sigDelta', direction: 'before', regex: /if\((\w+)\.type!=="thinking"\)/ }],
 * injections: [{
 *   targetAnchorId: 'sigDelta', position: 'after',
 *   template: (vars) => `if(${vars.blockTypeVar}.type==="text")break;`, // vars populated at runtime
 * }],
 * ```
 *
 * ### The proper pattern — step by step
 *
 * 1. **Pick a structural anchor** — find stable literal text that exists across versions.
 *    It should be unique in the file (no false positives). Example: `case"signature_delta":if(`
 *
 * 2. **Define context windows** — how far before/after the anchor can relevant variables live?
 *    Wider windows = more matches but slower. Narrower = faster but risk missing vars.
 *
 * 3. **Write variable matchers** scoped to that anchor — use capture group 1 `(\w+)` or
 *    `([a-zA-Z_$]+)` to grab the minifier-chosen name. Direction `'before'` searches in the
 *    context window preceding the anchor; `'after'` searches following it.
 *
 *    **Keep matchers well-bounded.** The engine only searches within `[anchorStart - contextWindowBefore,
 *    anchorEnd + contextWindowAfter]`. Choose anchors and windows so the matcher can only encounter the
 *    variable you want — otherwise a same-name variable in an earlier handler (e.g. `let s = ...` at line 10)
 *    will be captured instead of the one near your anchor (line 850). If two variables share a short name,
 *    make the regex more specific: require adjacent context like `.split(` or `=s\.split(` rather than bare `\w+`.
 *
 * 4. **Write injection templates** that reference `vars.<matcherId>` — NOT hardcoded names.
 *    The engine resolves these at runtime to whatever variable the source actually uses.
 *
 * 5. **Generate safe new-variable names** via `safe[0]`, `safe[1]` etc. — single-char names
 *    picked from a-z that don't collide with any existing identifier in the file.
 *
 * ## How to use (3 steps)
 *
 * ### Step 1 — Define anchors
 * An **anchor** is a structural regex matching stable text in the minified source.
 * Each anchor declares `contextWindowBefore` / `contextWindowAfter` telling the
 * engine how far to search for variables and injections relative to the match.
 *
 * ```ts
 * const config: LexPatcherConfig = {
 *   anchors: [{
 *     id: 'editTool',
 *     regex: /run:async\(\{file_path:[a-zA-Z_$]+,old_string:/,
 *     contextWindowBefore: 5000,
 *     contextWindowAfter: 3000,
 *   }],
 * ```
 *
 * ### Step 2 — Define variable matchers and injections
 * Each **variable matcher** searches a bounded window near an anchor. The engine
 * then generates safe single-char names for new variables and applies injection
 * templates at the correct positions.
 *
 * ```ts
 *   variables: [{
 *     id: 'contentVar',
 *     anchorId: 'editTool',
 *     direction: 'before',    // search in the window before this anchor's match
 *     regex: /([a-zA-Z_$]+)=s\.split\(/,  // group 1 captures the variable name
 *   }],
 *
 *   injections: [{
 *     targetAnchorId: 'editTool',
 *     position: 'after',      // inject after this anchor's match text
 *     template: (vars, safe) => `let ${safe[0]}=${vars.contentVar}.trim();`,
 *                              //          ^^^ engine-safe new var   ^^^^^ runtime-captured old var
 *   }],
 * };
 * ```
 *
 * ### Step 3 — Run it
 *
 * ```ts
 * const patcher = new LexPatcher(config);
 * const result = patcher.apply(minifiedSource);
 * if (!result) throw new Error('patch failed');
 * // result is the modified source, ready to repack into binary.
 * ```
 *
 * ## Variable name generation
 * The engine scans all identifiers in the file and picks the shortest single-
 * character variable (a–z minus already-used params) that doesn't collide with
 * any existing identifier. This guarantees injection-safe names without needing
 * per-version knowledge of what variables are already taken.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnchorConfig {
  /** Unique ID for this anchor; referenced by variables and injections */
  id: string;
  /** Structural regex matching stable text in the minified source. */
  regex: RegExp | string;
  /** Bytes before the match start to search for variables / injections */
  contextWindowBefore: number;
  /** Bytes after the match end to search for variables / injections */
  contextWindowAfter: number;
  /** Extra bytes past the match end to include in "before" variable searches.
   *  Useful when some patterns (e.g., `new_string:X`) appear just after the anchor
   *  text itself ends, between the match and the next structural delimiter. */
  searchExtensionAfterMatch?: number;
}

export interface VariableMatcherConfig {
  /** Unique ID. The regex capture group is stored as capturedVars[id]. */
  id: string;
  /** Which anchor this variable searches near */
  anchorId: string;
  /** Search 'before' or 'after' the anchor match text */
  direction: 'before' | 'after';
  /** Regex to find the variable in context. Group 1 is captured as the value. */
  regex: RegExp | string;
}

export interface InjectionConfig {
  /** Which anchor this injection targets */
  targetAnchorId: string;
  /** Insert before or after the matched text at this anchor */
  position: 'before' | 'after';
  /** Template function receiving capturedVars and safeNames. Returns injected code. */
  template: (
    capturedVars: Record<string, string>,
    safeNames: string[]
  ) => string;
}

export interface LexPatcherConfig {
  anchors: AnchorConfig[];
  variables: VariableMatcherConfig[];
  injections: InjectionConfig[];
}

/** Internal representation after matching phase — used by injection phase */
interface AnchorMatchResult {
  id: string;
  matchText: string;
  fullMatch: RegExpExecArray | null;
  startOffset: number; // absolute position in source
  contextBeforeEnd: number; // end of the "before" search window (absolute)
  contextAfterStart: number; // start of the "after" search window (absolute)
}

// ---------------------------------------------------------------------------
// LexPatcher engine
// ---------------------------------------------------------------------------

export class LexPatcher {
  private config: LexPatcherConfig;

  constructor(config: LexPatcherConfig) {
    if (!config.anchors?.length)
      throw new Error('LexPatcher requires at least one anchor');
    this.config = config;
  }

  /** Apply the patch to minified source code. Returns null on failure. */
  apply(source: string): string | null {
    try {
      const plan = this.buildPlan(source);
      if (!plan) return null;
      return this.inject(source, plan);
    } catch (err) {
      console.error(
        `[lexPatcher] error: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  // ---- Phase 1a: match structural anchors ----

  private matchAnchors(source: string): AnchorMatchResult[] | null {
    const results: AnchorMatchResult[] = [];

    for (const ac of this.config.anchors) {
      let regex: RegExp;
      if (typeof ac.regex === 'string') {
        regex = new RegExp(ac.regex, 'g');
      } else {
        // Clone to avoid mutating shared regex state
        const flags = ac.regex.flags.includes('g')
          ? ac.regex.flags
          : `${ac.regex.flags}g`;
        regex = new RegExp(ac.regex.source, flags);
      }

      const match = regex.exec(source);
      if (!match) {
        console.error(`[lexPatcher] anchor '${ac.id}' not found in source`);
        return null;
      }

      results.push({
        id: ac.id,
        matchText: match[0],
        fullMatch: match,
        startOffset: match.index,
        contextBeforeEnd: Math.max(0, match.index - ac.contextWindowBefore),
        contextAfterStart: match.index + match[0].length,
      });
    }

    return results;
  }

  // ---- Phase 1b: match variable patterns ----

  private matchVariables(
    source: string,
    anchors: AnchorMatchResult[]
  ): Record<string, string> {
    const captured: Record<string, string> = {};

    for (const vm of this.config.variables) {
      const anchor = anchors.find(a => a.id === vm.anchorId);
      if (!anchor) continue;

      let searchRegion: string | null = null;

      if (vm.direction === 'before') {
        // Include the FULL anchor match text in the before-search region, since patterns
        // like file_path:X or old_string:Y may appear inside the anchor's own matched text.
        // Also extend past the match end to capture variables that sit just after it
        // (between the anchor text and the next structural delimiter).
        const ac = this.config.anchors.find(a => a.id === anchor.id)!;
        const extensionAfterMatch = ac.searchExtensionAfterMatch || 0;
        const endOfSearch =
          anchor.startOffset + anchor.matchText.length + extensionAfterMatch;
        searchRegion = source.substring(anchor.contextBeforeEnd, endOfSearch);
      } else {
        const end = Math.min(
          source.length,
          anchor.contextAfterStart + vm.anchorId.length + 2000
        );
        searchRegion = source.substring(anchor.contextAfterStart, end);
      }

      if (!searchRegion) continue;

      let regex: RegExp;
      if (typeof vm.regex === 'string') {
        regex = new RegExp(vm.regex);
      } else {
        const flags = vm.regex.flags.includes('g')
          ? vm.regex.flags
          : vm.regex.flags;
        regex = new RegExp(vm.regex.source, flags);
      }

      const match = regex.exec(searchRegion);
      if (!match || !match[1]) {
        console.error(
          `[lexPatcher] variable '${vm.id}' not found near anchor '${anchor.id}'`
        );
        return captured; // caller checks completeness
      }

      captured[vm.id] = match[1];
    }

    return captured;
  }

  // ---- Phase 1c: find all identifiers for safe name generation ----

  private findAllMinifiedIds(source: string): Set<string> {
    const ids = new Set<string>();
    const re = /[a-zA-Z_$][\w$]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) ids.add(m[0]);
    return ids;
  }

  /** Generate n safe variable names not in use by the source.
   *  Tries single-char first, then falls back to short multi-char names. */
  private generateSafeNames(
    source: string,
    paramVars: string[], // existing minified var names we must avoid
    count: number
  ): string[] {
    const used = this.findAllMinifiedIds(source);

    // Build a set of single-char names already taken by params or identifiers
    const reserved = new Set<string>();
    for (const v of paramVars) {
      if (v.length === 1) reserved.add(v);
    }

    const safe: string[] = [];

    // First pass: try single chars a-z
    for (let ch = 97; ch <= 122 && safe.length < count; ch++) {
      const name = String.fromCharCode(ch);
      if (!reserved.has(name) && !used.has(name)) {
        safe.push(name);
      }
    }

    // Second pass: fall back to short multi-char names (avoiding collisions with existing vars)
    const shortCandidates = [
      '_a',
      '_b',
      '_c',
      '__x',
      '__y',
      '__z',
      'x_',
      'y_',
      'z_',
    ];
    for (const name of shortCandidates) {
      if (safe.length >= count) break;
      if (!reserved.has(name) && !used.has(name)) {
        safe.push(name);
      }
    }

    // Third pass: try two-char combos from unused letters
    if (safe.length < count) {
      const unusedChars = [];
      for (let ch = 97; ch <= 122 && unusedChars.length < 6; ch++) {
        const c = String.fromCharCode(ch);
        if (!reserved.has(c) && !used.has(c)) unusedChars.push(c);
      }
      outer: for (const a of unusedChars) {
        for (const b of unusedChars) {
          if (safe.length >= count) break outer;
          const name = a + b;
          if (!reserved.has(name) && !used.has(name)) {
            safe.push(name);
          }
        }
      }
    }

    return safe;
  }

  // ---- Phase 1d: build complete plan ----

  private buildPlan(source: string): {
    anchors: AnchorMatchResult[];
    variables: Record<string, string>;
    injections: InjectionPlan[];
  } | null {
    const anchors = this.matchAnchors(source);
    if (!anchors) return null;

    // Collect param var names (single-char vars already used in the source)
    const paramVars: string[] = [];
    for (const val of Object.values(this.matchVariables(source, anchors))) {
      if (val.length === 1) paramVars.push(val);
    }

    const variables = this.matchVariables(source, anchors);
    if (Object.keys(variables).length !== this.config.variables.length) {
      return null; // not all required vars matched
    }

    const injections = this.config.injections.map(inj => {
      const anchor = anchors.find(a => a.id === inj.targetAnchorId);
      if (!anchor)
        throw new Error(
          `injection '${inj.targetAnchorId}' has no matching anchor`
        );
      return { ...inj, anchor };
    });

    // Pre-compute safe names for each injection (all injections share the same pool)
    const allSafe = this.generateSafeNames(source, paramVars, 3);

    return {
      anchors,
      variables,
      injections: injections.map(inj => ({
        ...inj,
        safeNames: allSafe.slice(0, 3), // first 3 safe names
      })),
    };
  }

  // ---- Phase 2: inject in reverse offset order ----

  private inject(
    source: string,
    plan: ReturnType<LexPatcher['buildPlan']>
  ): string | null {
    if (!plan) return null;

    // Sort injections by position descending to insert from end to start (preserves offsets)
    const sorted = [...plan.injections].sort(
      (a, b) => b.anchor.startOffset - a.anchor.startOffset
    );

    let offsetShift = 0;

    for (const inj of sorted) {
      let injectPos: number;

      if (inj.position === 'before') {
        // Insert at the start of the "after" context window relative to anchor
        const targetAnchor = plan.anchors.find(
          a => a.id === inj.targetAnchorId
        );
        if (!targetAnchor) continue;
        injectPos = Math.min(
          source.length,
          targetAnchor.contextAfterStart + offsetShift
        );
      } else {
        // After the match text (shifted for prior injections)
        const anchor = plan.anchors.find(a => a.id === inj.targetAnchorId);
        if (!anchor) continue;
        injectPos = Math.min(
          source.length,
          anchor.startOffset + anchor.matchText.length + offsetShift
        );
      }

      const code = inj.template(plan.variables, inj.safeNames);
      if (!code) continue;

      source = source.slice(0, injectPos) + code + source.slice(injectPos);
      offsetShift += code.length;
    }

    return source;
  }
}

interface InjectionPlan extends InjectionConfig {
  anchor: AnchorMatchResult;
  safeNames: string[]; // pre-computed safe variable names for this injection
}
