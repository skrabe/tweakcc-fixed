// Inline-Blob Overrides Patch
//
// Anthropic embeds several prompt-shaped strings in cli.js as inline JS values
// that are NOT in the Piebald `prompts-X.Y.Z.json` extract (because they aren't
// shaped like a named template-literal with ${VAR} interpolations).  Three
// kinds we care about:
//
//   1. String-array literals — `VAR=["## Header","",...]`  (joined with '\n'
//      at runtime, spread into the system prompt assembly).  Used for the
//      `## Types of memory` <types> block, the `## What NOT to save in memory`
//      bullet list, etc.
//
//   2. Template-literal values — `` `# Section\n...` ``  embedded as fn return
//      values or `var X = \`...\`` assignments.  Used for tool descriptions
//      (TaskUpdate/TaskList/TaskGet, ShareOnboardingGuide), feature notes
//      (focus mode, locale), and the system-prompt intro line.
//
//   3. Bare string literals — `var X = '...'`  (rare).  Currently unused
//      here but the kind is reserved for future use.
//
// This patch loads `inline-*.md` overrides from SYSTEM_PROMPTS_DIR, finds
// each blob's anchor in cli.js, walks the literal's syntactic boundaries
// (array brackets / template backticks), and splices in the override body.
// If an override file isn't present we leave the pristine value untouched.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';

import { debug, escapeNonAscii as escapeNonAsciiUnicode } from '../utils';
import { SYSTEM_PROMPTS_DIR } from '../config';
import { showDiff } from './patchDiffing';

interface InlineBlobFrontmatter {
  name: string;
  description: string;
  inlineBlobAnchor: string;
  inlineBlobKind: 'array' | 'template' | 'string';
  injectionGate: string;
  ccVersion: string;
  inlineBlobRawPassthrough?: string;
}

interface InlineBlobOverride {
  filename: string;
  frontmatter: InlineBlobFrontmatter;
  body: string;
}

// Parse an inline-blob override's HTML-comment frontmatter with gray-matter.
//
// The anchor is a regex pattern; several overrides store it as a multi-line
// YAML folded (`>-`) or literal (`|-`) block scalar (the pattern is too long
// for one line). The previous hand-rolled line-by-line parser captured only
// the same-line text after the key, so a folded anchor parsed to the bare
// `>-`/`|-` indicator — a regex that matches near the top of cli.js and made
// the boundary walker splice the override body into core runtime code
// (corrupting it / "Expected CommonJS module to have a function wrapper" at
// boot). gray-matter implements YAML's block-scalar folding correctly, so the
// anchor resolves to the intended long pattern. The anchor's own
// inert-`${VAR}`-in-a-string concerns don't apply here: it is consumed as a
// RegExp, never embedded in the binary.
export const parseFrontmatter = (
  filename: string,
  text: string
): InlineBlobOverride | null => {
  if (!/^<!--/.test(text)) return null;
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(text, { delimiters: ['<!--', '-->'] });
  } catch {
    return null;
  }
  const data = parsed.data as Partial<InlineBlobFrontmatter>;
  if (
    typeof data.inlineBlobAnchor !== 'string' ||
    !data.inlineBlobAnchor ||
    typeof data.inlineBlobKind !== 'string' ||
    !['array', 'template', 'string'].includes(data.inlineBlobKind)
  ) {
    return null;
  }
  // Match the previous body extraction: drop the leading newline gray-matter
  // keeps after the closing delimiter and any trailing newlines.
  const body = parsed.content.replace(/^\n+/, '').replace(/\n+$/, '');
  return {
    filename,
    frontmatter: data as InlineBlobFrontmatter,
    body,
  };
};

// ---------------------------------------------------------------------------
// Boundary walkers
// ---------------------------------------------------------------------------

// Walk a JS array literal at content[eq] (must be '['), return index past ']'.
// Tracks strings of all three kinds (",',`) and skips ${...} interpolation
// inside template-literal elements.
const walkArray = (content: string, eq: number): number | null => {
  if (content[eq] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let quote: string | null = null;
  let i = eq;
  while (i < content.length) {
    const c = content[i];
    if (inStr) {
      if (c === '\\' && i + 1 < content.length) {
        i += 2;
        continue;
      }
      if (c === quote) {
        inStr = false;
      } else if (
        quote === '`' &&
        c === '$' &&
        i + 1 < content.length &&
        content[i + 1] === '{'
      ) {
        let bd = 1;
        let j = i + 2;
        while (j < content.length && bd > 0) {
          const cj = content[j];
          if (cj === '\\' && j + 1 < content.length) {
            j += 2;
            continue;
          }
          if (cj === '`') {
            const innerEnd = walkTemplate(content, j);
            if (innerEnd === null) {
              bd = 0;
              break;
            }
            j = innerEnd;
            continue;
          }
          if (cj === '{') bd++;
          else if (cj === '}') bd--;
          j++;
        }
        i = j;
        continue;
      }
    } else {
      if (c === '"' || c === "'" || c === '`') {
        inStr = true;
        quote = c;
      } else if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    i++;
  }
  return null;
};

// Walk a JS template literal at content[start] (must be '`'), return index past '`'.
const walkTemplate = (content: string, start: number): number | null => {
  if (content[start] !== '`') return null;
  let i = start + 1;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\' && i + 1 < content.length) {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && i + 1 < content.length && content[i + 1] === '{') {
      let bd = 1;
      let j = i + 2;
      while (j < content.length && bd > 0) {
        const cj = content[j];
        if (cj === '\\' && j + 1 < content.length) {
          j += 2;
          continue;
        }
        if (cj === '`') {
          const innerEnd = walkTemplate(content, j);
          if (innerEnd === null) return null;
          j = innerEnd;
          continue;
        }
        if (cj === '{') bd++;
        else if (cj === '}') bd--;
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Re-encoding bodies for cli.js delimiter context
// ---------------------------------------------------------------------------

const detectUnicodeEscaping = (content: string): boolean =>
  /\\u[0-9a-fA-F]{4}/.test(content);

// Escape body text for embedding as the value of a double-quoted JS string
// literal.  Used for each element of an array-kind override.
const encodeAsDoubleQuotedString = (
  text: string,
  escapeNonAscii: boolean
): string => {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (escapeNonAscii && code > 0x7e) {
      if (code <= 0xffff) {
        out += '\\u' + code.toString(16).padStart(4, '0');
      } else {
        // surrogate pair
        const c = code - 0x10000;
        const hi = 0xd800 + (c >> 10);
        const lo = 0xdc00 + (c & 0x3ff);
        out +=
          '\\u' +
          hi.toString(16).padStart(4, '0') +
          '\\u' +
          lo.toString(16).padStart(4, '0');
      }
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
};

// Escape body text for embedding as a template-literal value.  Backticks and
// $ must be escaped only when they'd cause syntax errors; preserve ${...}
// interpolations verbatim.
/**
 * Extract the top-level `${...}` interpolation expressions (verbatim, without
 * the surrounding `${ }`) from a template-literal body, in order.
 *
 * The minified-name inside a `${...}` differs between Mac and Linux native
 * builds of CC. Capturing them from the pristine template lets the patch
 * rewrite the override's own `${...}` placeholders to whatever names the
 * binary actually carries — preserving dynamic behavior across platforms.
 */
const extractTemplateInterpolations = (text: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (
      text[i] === '$' &&
      i + 1 < text.length &&
      text[i + 1] === '{' &&
      (i === 0 || text[i - 1] !== '\\')
    ) {
      let bd = 1;
      let j = i + 2;
      let inS = false;
      let q: string | null = null;
      const start = j;
      while (j < text.length && bd > 0) {
        const cj = text[j];
        if (inS) {
          if (cj === '\\' && j + 1 < text.length) {
            j += 2;
            continue;
          }
          if (cj === q) inS = false;
        } else {
          if (cj === '"' || cj === "'" || cj === '`') {
            inS = true;
            q = cj;
          } else if (cj === '{') bd++;
          else if (cj === '}') {
            bd--;
            if (bd === 0) break;
          }
        }
        j++;
      }
      out.push(text.slice(start, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
};

/**
 * Rewrite the top-level `${...}` interpolations in `body` by replacing the
 * Nth one with `pristineExprs[N]`. The override body keeps its surrounding
 * literal text exactly; only the inside of each `${...}` is swapped to match
 * what the current binary's pristine template carries.
 *
 * If the override has more interpolations than the pristine, the extras are
 * left untouched (and will likely fail at runtime — the override author
 * needs to align). If pristine has more, the remainder is unused; the
 * override may have intentionally dropped some interpolations.
 */
const remapTemplateInterpolations = (
  body: string,
  pristineExprs: string[]
): string => {
  let out = '';
  let i = 0;
  let idx = 0;
  while (i < body.length) {
    if (
      body[i] === '$' &&
      i + 1 < body.length &&
      body[i + 1] === '{' &&
      (i === 0 || body[i - 1] !== '\\')
    ) {
      let bd = 1;
      let j = i + 2;
      let inS = false;
      let q: string | null = null;
      while (j < body.length && bd > 0) {
        const cj = body[j];
        if (inS) {
          if (cj === '\\' && j + 1 < body.length) {
            j += 2;
            continue;
          }
          if (cj === q) inS = false;
        } else {
          if (cj === '"' || cj === "'" || cj === '`') {
            inS = true;
            q = cj;
          } else if (cj === '{') bd++;
          else if (cj === '}') {
            bd--;
            if (bd === 0) break;
          }
        }
        j++;
      }
      if (idx < pristineExprs.length) {
        out += '${' + pristineExprs[idx] + '}';
      } else {
        out += body.slice(i, j + 1);
      }
      idx++;
      i = j + 1;
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
};

/**
 * Collect minified `${var}` interpolation names from `text` (any nesting
 * depth). "Minified" = a short (1-4 char) identifier that is NOT an ALL_CAPS
 * tweakcc human-name placeholder — the same shape the apply-safety harness
 * counts. Only bare `${ident}` slots are collected (not `${a.b}` / `${f(x)}`
 * expressions): those carry no single binding we can round-trip, and the
 * remap rewrites them from the pristine wholesale.
 */
export const minifiedInterpNames = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<!\\)\$\{([A-Za-z$][\w$]*)\}/g)) {
    const v = m[1];
    if (v.length > 4) continue; // long => not a minified slot
    // skip ALL_CAPS_WITH_DIGITS human-name placeholders (e.g. AGENT, VERSION)
    if (v === v.toUpperCase() && /[A-Z]/.test(v) && v.length > 2) continue;
    out.add(v);
  }
  return out;
};

/**
 * Minified `${var}` interpolation names that `replacement` introduces but the
 * `pristine` literal it replaces does NOT contain. A non-empty result means
 * the override carries a stale minified name (authored against an older CC
 * build) the remap couldn't realign — splicing it would reference an
 * undefined/wrong var at that scope. The caller skips-with-warning.
 */
export const introducedMinifiedSlots = (
  pristine: string,
  replacement: string
): string[] => {
  const had = minifiedInterpNames(pristine);
  const out: string[] = [];
  for (const name of minifiedInterpNames(replacement)) {
    if (!had.has(name)) out.push(name);
  }
  return out;
};

/**
 * Walk a JS array body (text between `[` and `]`, exclusive), collecting
 * free identifier references in order. Skips identifiers inside string
 * literals and property-access positions (after `.` or `?.`).
 *
 * Used for array-kind raw-passthrough overrides whose bodies contain
 * spread (`...VAR`) or function-call (`VAR(...)`) references to
 * minified names that differ between platforms.
 */
const extractArrayIdentifiers = (
  text: string
): Array<{ name: string; start: number; end: number }> => {
  const out: Array<{ name: string; start: number; end: number }> = [];
  let i = 0;
  let inStr = false;
  let quote: string | null = null;
  const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdCont = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      if (c === '\\' && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (c === quote) {
        inStr = false;
        i++;
        continue;
      }
      if (
        quote === '`' &&
        c === '$' &&
        i + 1 < text.length &&
        text[i + 1] === '{'
      ) {
        // Recurse into the interpolation expression so identifiers nested
        // inside a template-literal array element (e.g. `${to5[_]}`, `${GE8}`)
        // are remapped too. These minified names are platform-specific (differ
        // Mac↔Linux), so a raw-passthrough body must pick them up from the
        // pristine literal positionally rather than carry stale names that the
        // top-level array scan can't reach (the lL8 mis-bind). String/brace
        // aware so `${cond?"}":"x"}` doesn't terminate early.
        let bd = 1;
        let j = i + 2;
        let innerStr = false;
        let innerQ: string | null = null;
        while (j < text.length && bd > 0) {
          const cj = text[j];
          if (innerStr) {
            if (cj === '\\' && j + 1 < text.length) {
              j += 2;
              continue;
            }
            if (cj === innerQ) innerStr = false;
            j++;
            continue;
          }
          if (cj === '"' || cj === "'" || cj === '`') {
            innerStr = true;
            innerQ = cj;
            j++;
            continue;
          }
          if (cj === '{') bd++;
          else if (cj === '}') {
            bd--;
            if (bd === 0) break;
          }
          j++;
        }
        const inner = text.slice(i + 2, j);
        for (const r of extractArrayIdentifiers(inner)) {
          out.push({
            name: r.name,
            start: r.start + i + 2,
            end: r.end + i + 2,
          });
        }
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = true;
      quote = c;
      i++;
      continue;
    }
    if (isIdStart(c)) {
      const prev = i > 0 ? text[i - 1] : '';
      const prev2 = i > 1 ? text[i - 2] : '';
      const prev3 = i > 2 ? text[i - 3] : '';
      // Property access: `.x` or `?.x` — but NOT the spread `...x`.
      const isSpread = prev === '.' && prev2 === '.' && prev3 === '.';
      const propAccess =
        !isSpread && (prev === '.' || (prev === '?' && prev2 === '?'));
      const start = i;
      while (i < text.length && isIdCont(text[i])) i++;
      const name = text.slice(start, i);
      if (
        !propAccess &&
        !['true', 'false', 'null', 'undefined', 'this', 'void', 'new'].includes(
          name
        )
      ) {
        out.push({ name, start, end: i });
      }
      continue;
    }
    i++;
  }
  return out;
};

/**
 * Rewrite free identifier references in the override array body by
 * substituting the Nth identifier with the Nth name from `pristineIds`
 * (positional). Used for raw-passthrough array-kind overrides whose
 * bodies reference platform-specific minified names — the pristine
 * array carries the names the binary actually has, so positional
 * substitution keeps the override portable across Mac/Linux builds.
 */
const remapArrayIdentifiers = (body: string, pristineIds: string[]): string => {
  const refs = extractArrayIdentifiers(body);
  if (refs.length === 0) return body;
  let out = '';
  let i = 0;
  let idx = 0;
  for (const r of refs) {
    out += body.slice(i, r.start);
    if (idx < pristineIds.length) {
      out += pristineIds[idx];
    } else {
      out += r.name;
    }
    i = r.end;
    idx++;
  }
  out += body.slice(i);
  return out;
};

const encodeAsTemplateLiteral = (
  text: string,
  escapeNonAscii: boolean
): string => {
  let out = '`';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // preserve ${...} unchanged
    if (ch === '$' && i + 1 < text.length && text[i + 1] === '{') {
      // walk the brace block (with string/depth tracking) and copy verbatim
      let bd = 1;
      let j = i + 2;
      let inS = false;
      let q: string | null = null;
      while (j < text.length && bd > 0) {
        const cj = text[j];
        if (inS) {
          if (cj === '\\' && j + 1 < text.length) {
            j += 2;
            continue;
          }
          if (cj === q) inS = false;
        } else {
          if (cj === '"' || cj === "'" || cj === '`') {
            inS = true;
            q = cj;
          } else if (cj === '{') bd++;
          else if (cj === '}') bd--;
        }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '`') out += '\\`';
    else if (escapeNonAscii && code > 0x7e) {
      if (code <= 0xffff) {
        out += '\\u' + code.toString(16).padStart(4, '0');
      } else {
        const c = code - 0x10000;
        const hi = 0xd800 + (c >> 10);
        const lo = 0xdc00 + (c & 0x3ff);
        out +=
          '\\u' +
          hi.toString(16).padStart(4, '0') +
          '\\u' +
          lo.toString(16).padStart(4, '0');
      }
    } else {
      out += ch;
    }
    i++;
  }
  out += '`';
  return out;
};

// ---------------------------------------------------------------------------
// Main patch entry point
// ---------------------------------------------------------------------------

export interface InlineBlobApplyResult {
  filename: string;
  name: string;
  applied: boolean;
  failed: boolean;
  skipped?: boolean;
  details: string;
}

export const applyInlineBlobOverrides = async (
  content: string
): Promise<{ content: string; results: InlineBlobApplyResult[] }> => {
  const escapeNonAscii = detectUnicodeEscaping(content);
  if (escapeNonAscii) {
    debug('inlineBlobOverrides: cli.js uses unicode escaping');
  }

  // Discover overrides
  let entries: string[];
  try {
    entries = await fs.readdir(SYSTEM_PROMPTS_DIR);
  } catch {
    return { content, results: [] };
  }
  const candidates = entries.filter(
    n => n.startsWith('inline-') && n.endsWith('.md')
  );
  if (candidates.length === 0) return { content, results: [] };

  const results: InlineBlobApplyResult[] = [];
  for (const filename of candidates.sort()) {
    const fullPath = path.join(SYSTEM_PROMPTS_DIR, filename);
    let raw: string;
    try {
      raw = await fs.readFile(fullPath, 'utf8');
    } catch (err) {
      results.push({
        filename,
        name: filename,
        applied: false,
        failed: true,
        details: `read failed: ${err}`,
      });
      continue;
    }
    const parsed = parseFrontmatter(filename, raw);
    if (!parsed) {
      results.push({
        filename,
        name: filename,
        applied: false,
        failed: true,
        details: 'frontmatter missing inlineBlobAnchor/Kind',
      });
      continue;
    }
    const { frontmatter, body } = parsed;
    let anchorRe: RegExp;
    try {
      // Anchor regex is stored as a raw pattern; use 's' flag so '.' crosses
      // newlines (some anchors include literal newlines for template literals).
      anchorRe = new RegExp(frontmatter.inlineBlobAnchor, 's');
    } catch (err) {
      results.push({
        filename,
        name: frontmatter.name,
        applied: false,
        failed: true,
        details: `invalid anchor regex: ${err}`,
      });
      continue;
    }

    const m = anchorRe.exec(content);
    if (!m) {
      results.push({
        filename,
        name: frontmatter.name,
        applied: false,
        failed: true,
        details: 'anchor not found in cli.js',
      });
      continue;
    }

    let startOfBlob: number;
    let endOfBlob: number;
    let replacement: string;

    if (frontmatter.inlineBlobKind === 'array') {
      const lb = content.indexOf('[', m.index);
      if (lb === -1) {
        results.push({
          filename,
          name: frontmatter.name,
          applied: false,
          failed: true,
          details: 'no [ after anchor',
        });
        continue;
      }
      const end = walkArray(content, lb);
      if (end === null) {
        results.push({
          filename,
          name: frontmatter.name,
          applied: false,
          failed: true,
          details: 'array walker failed',
        });
        continue;
      }
      startOfBlob = lb;
      endOfBlob = end;
      if (frontmatter.inlineBlobRawPassthrough === 'true') {
        // Body holds the raw array contents (between [ and ]) verbatim.
        // Remap bare identifiers to whatever names the binary's pristine
        // array carries — these names are minifier output and differ
        // between Mac and Linux native builds.
        const pristineArrayBody = content.slice(lb + 1, end - 1);
        const pristineIds = extractArrayIdentifiers(pristineArrayBody).map(
          r => r.name
        );
        const remappedBody = remapArrayIdentifiers(body, pristineIds);
        // The raw-passthrough body is verbatim JS (array elements that may carry
        // `${expr}` interpolations or nested templates), so it can't be string-
        // encoded like the other kinds. Escape its non-ASCII to `\uXXXX` — valid
        // inside JS string and template literals — so an em-dash in the body
        // survives Bun's Latin-1 module storage instead of mojibaking in the
        // prompt the model reads.
        replacement =
          '[' +
          (escapeNonAscii
            ? escapeNonAsciiUnicode(remappedBody)
            : remappedBody) +
          ']';
      } else {
        // Treat each line of the body as one quoted string element
        const lines = body.split('\n');
        const elements = lines.map(line =>
          encodeAsDoubleQuotedString(line, escapeNonAscii)
        );
        replacement = '[' + elements.join(',') + ']';
      }
    } else if (frontmatter.inlineBlobKind === 'template') {
      const startTick =
        content[m.index] === '`' ? m.index : content.indexOf('`', m.index);
      if (startTick === -1) {
        results.push({
          filename,
          name: frontmatter.name,
          applied: false,
          failed: true,
          details: 'no backtick at/after anchor',
        });
        continue;
      }
      const end = walkTemplate(content, startTick);
      if (end === null) {
        results.push({
          filename,
          name: frontmatter.name,
          applied: false,
          failed: true,
          details: 'template walker failed',
        });
        continue;
      }
      startOfBlob = startTick;
      endOfBlob = end;

      const pristineBody = content.slice(startTick + 1, end - 1);
      const pristineExprs = extractTemplateInterpolations(pristineBody);
      const remappedBody = remapTemplateInterpolations(body, pristineExprs);

      replacement = encodeAsTemplateLiteral(remappedBody, escapeNonAscii);
    } else if (frontmatter.inlineBlobKind === 'string') {
      // Walk a single- or double-quoted string starting at/after the anchor.
      let quotePos = m.index;
      while (
        quotePos < content.length &&
        content[quotePos] !== '"' &&
        content[quotePos] !== "'"
      ) {
        quotePos++;
      }
      if (quotePos >= content.length) {
        results.push({
          filename,
          name: frontmatter.name,
          applied: false,
          failed: true,
          details: 'no quote at/after anchor',
        });
        continue;
      }
      const quote = content[quotePos];
      let j = quotePos + 1;
      while (j < content.length) {
        if (content[j] === '\\') {
          j += 2;
          continue;
        }
        if (content[j] === quote) {
          break;
        }
        j++;
      }
      if (j >= content.length) {
        results.push({
          filename,
          name: frontmatter.name,
          applied: false,
          failed: true,
          details: 'unterminated string',
        });
        continue;
      }
      startOfBlob = quotePos;
      endOfBlob = j + 1;
      replacement = encodeAsDoubleQuotedString(body, escapeNonAscii);
    } else {
      results.push({
        filename,
        name: frontmatter.name,
        applied: false,
        failed: true,
        details: `kind ${frontmatter.inlineBlobKind} not implemented`,
      });
      continue;
    }

    // Guard 1 — the blob must begin within (or at the head of) the anchor's
    // matched span. The boundary walkers scan forward from m.index for the
    // first `[`/backtick/quote, so when the anchor is mis-specified (e.g. a
    // kind:template anchor that actually matched a "…" string whose first
    // backtick is an inner literal), the walker skips PAST the anchor into a
    // different literal and splices the override body there — corrupting
    // cli.js. A correct anchor either contains the blob's opening delimiter
    // (string / template) or ends right where it opens (array: `…=[`), i.e.
    // startOfBlob <= anchorEnd; and the blob must extend past where the anchor
    // began (endOfBlob > anchorStart). If the blob opens strictly after the
    // anchor ends, the walker wandered — skip-with-warning rather than corrupt.
    const anchorStart = m.index;
    const anchorEnd = m.index + m[0].length;
    const overlaps = startOfBlob <= anchorEnd && endOfBlob > anchorStart;
    if (!overlaps) {
      console.log(
        `inline-blob: anchor for "${frontmatter.name}" (${filename}) matched outside its target literal — cannot apply safely, skipping`
      );
      results.push({
        filename,
        name: frontmatter.name,
        applied: false,
        failed: false,
        skipped: true,
        details: 'anchor matched outside target literal — skipped (unsafe)',
      });
      continue;
    }

    // Guard 2 — round-trip the interpolated variables. An override body may
    // carry `${MINIFIED}` interpolations (or, in raw-passthrough arrays, bare
    // identifier refs) that the remap step rewrites to whatever names the
    // current binary uses. If the override's structure doesn't line up with
    // the pristine literal (e.g. a nested `${cond?`…${VAR}…`}` the top-level
    // remap can't reach), a stale minified name authored against an older CC
    // survives verbatim and references an undefined/wrong var at this scope
    // (the K9/lL8 mis-bind: ReferenceError, or silently wrong content). Every
    // minified `${var}` the replacement introduces must already appear in the
    // pristine literal it replaces; if not, skip-with-warning rather than
    // splice a name the binary doesn't bind here. Human-name placeholders
    // (ALL_CAPS) are intentional and handled elsewhere — only short minified
    // tokens are checked, matching the apply-safety bar.
    const pristineBlob = content.slice(startOfBlob, endOfBlob);
    const introduced = introducedMinifiedSlots(pristineBlob, replacement);
    if (introduced.length > 0) {
      console.log(
        `inline-blob: "${frontmatter.name}" (${filename}) would introduce undefined var \${${introduced[0]}} (markdown out of sync with CC prompt data) — cannot apply safely, skipping`
      );
      results.push({
        filename,
        name: frontmatter.name,
        applied: false,
        failed: false,
        skipped: true,
        details: `would introduce undefined \${${introduced[0]}} — skipped (unsafe)`,
      });
      continue;
    }

    const before = content;
    content =
      content.slice(0, startOfBlob) + replacement + content.slice(endOfBlob);

    const origLen = endOfBlob - startOfBlob;
    const newLen = replacement.length;
    const charDiff = origLen - newLen;
    const status =
      charDiff > 0
        ? `${charDiff} fewer chars`
        : charDiff < 0
          ? `${-charDiff} more chars`
          : 'unchanged';
    showDiff(before, content, replacement, startOfBlob, endOfBlob);
    results.push({
      filename,
      name: frontmatter.name,
      applied: true,
      failed: false,
      details: status,
    });
  }

  return { content, results };
};
