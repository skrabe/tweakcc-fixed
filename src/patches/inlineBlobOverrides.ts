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

import { debug } from '../utils';
import { SYSTEM_PROMPTS_DIR } from '../config';
import { showDiff } from './patchDiffing';

// Minimal frontmatter parser — handles the format produced by the Python
// extractor (HTML-comment delimited, single-quoted or double-quoted values).
// We don't depend on gray-matter to keep this self-contained.
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

const parseYamlValue = (raw: string): string => {
  raw = raw.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    // double-quoted: unescape \\ \" \n
    const inner = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\' && i + 1 < inner.length) {
        const n = inner[i + 1];
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === '"') out += '"';
        else if (n === '\\') out += '\\';
        else if (n === "'") out += "'";
        else out += n;
        i++;
      } else {
        out += c;
      }
    }
    return out;
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    // single-quoted: only '' (doubled) is an escape; backslashes are literal
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
};

const parseFrontmatter = (
  filename: string,
  text: string
): InlineBlobOverride | null => {
  const m = text.match(/^<!--\s*([\s\S]*?)\s*-->\s*\n?/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (kv) fm[kv[1]] = parseYamlValue(kv[2]);
  }
  const fmTyped = fm as unknown as InlineBlobFrontmatter;
  if (
    !fmTyped.inlineBlobAnchor ||
    !fmTyped.inlineBlobKind ||
    !['array', 'template', 'string'].includes(fmTyped.inlineBlobKind)
  ) {
    return null;
  }
  const body = text.slice(m[0].length).replace(/\n+$/, '');
  return { filename, frontmatter: fmTyped, body };
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
        // Body holds the raw array contents (between [ and ]) verbatim
        replacement = '[' + body + ']';
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
      replacement = encodeAsTemplateLiteral(body, escapeNonAscii);
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
