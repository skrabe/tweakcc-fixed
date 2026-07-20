/**
 * Apply preflight for system-prompt overrides.
 *
 * ONE implementation, two entry points: `--validate-system-prompts` runs it as
 * a dry run, and `applyCustomization` runs it against the pristine binary
 * before its first mutation. Authors therefore get the same verdict the apply
 * will reach, and every check resolves through the SAME code the apply uses
 * (site resolution, delimiter, replacement encoding, inline-blob walkers,
 * reminder injectors) rather than a parallel re-derivation.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';

import { SYSTEM_PROMPTS_DIR, SYSTEM_REMINDERS_DIR } from './config';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import {
  encodeReplacementForDelimiter,
  loadSystemPromptsWithRegex,
  pristineBodiesById,
} from './systemPromptSync';
import {
  changedSpan,
  delimiterBefore,
  detectUnicodeEscaping,
  extractBuildTime,
  introducedRawNonAscii,
  lintBacktickEscapes,
  OffsetMapper,
  resolveCandidateSites,
  spanConflicts,
  SpanClaim,
} from './systemPromptSites';
import { applyInlineBlobOverrides } from './patches/inlineBlobOverrides';
import { REMINDER_REGISTRY } from './patches/systemReminderOverrides';
import {
  loadReminderOverride,
  substitutePlaceholders,
} from './systemReminderSync';

export type PreflightCheck =
  | 'cardinality'
  | 'ownership'
  | 'backtick-escape'
  | 'raw-non-ascii';

export type PreflightSeverity = 'error' | 'warning';

export interface PreflightFinding {
  check: PreflightCheck;
  severity: PreflightSeverity;
  /** Prompt id, inline-blob filename, or reminder id. */
  id: string;
  /** 0-based ordinal among the binary sites this id occupies. */
  site: number;
  /** 1-based line within the override file, when the finding has one. */
  line?: number;
  lineText?: string;
  offending?: string;
  required?: string;
  message: string;
}

export interface PreflightResult {
  version: string;
  promptsChecked: number;
  sitesChecked: number;
  findings: PreflightFinding[];
}

/**
 * Owner id -> ids it declares it shadows. `loadShadowSet` flattens this to "is
 * shadowed by someone", which cannot answer "may THIS override overlap THAT
 * one", so the ownership check reads the frontmatter itself.
 */
const loadShadowDeclarations = async (): Promise<Map<string, Set<string>>> => {
  const out = new Map<string, Set<string>>();
  const record = (owner: string, ids: unknown): void => {
    if (!Array.isArray(ids)) return;
    let set = out.get(owner);
    if (!set) {
      set = new Set<string>();
      out.set(owner, set);
    }
    for (const id of ids) {
      if (typeof id === 'string' && id) set.add(id);
    }
  };

  for (const dir of [SYSTEM_PROMPTS_DIR, SYSTEM_REMINDERS_DIR]) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.md')) continue;
      let text: string;
      try {
        text = await fs.readFile(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      let data: Record<string, unknown>;
      try {
        data = matter(text, { delimiters: ['<!--', '-->'] }).data;
      } catch {
        continue;
      }
      // An override is addressable by both its id and its filename: named
      // prompts claim spans under the id, inline blobs under the filename.
      record(name.slice(0, -3), data.shadows);
      record(name, data.shadows);
    }
  }
  for (const injection of REMINDER_REGISTRY) {
    record(injection.id, injection.shadows);
  }
  return out;
};

/**
 * Spans the inline-blob and system-reminder surfaces claim, measured the way
 * `--apply` measures them: sequentially, each anchor searched in the content
 * the previous surface left behind (two blobs sharing an anchor land on
 * different sites precisely because of that), then mapped back to pristine
 * coordinates so every surface's claims are comparable.
 */
const claimOverrideSurfaces = async (
  pristine: string
): Promise<SpanClaim[]> => {
  const claims: SpanClaim[] = [];
  const mapper = new OffsetMapper();
  let working = pristine;

  const record = (
    surface: SpanClaim['surface'],
    id: string,
    body: string,
    next: string
  ): void => {
    const span = changedSpan(working, next);
    // No change means the anchor did not resolve, or the override is a pristine
    // passthrough. Neither takes ownership of bytes away from anyone.
    if (!span) return;
    claims.push({
      ...mapper.spanToPristine(span),
      surface,
      id,
      site: 0,
      mutates: true,
      body,
    });
    mapper.record(span, span.end - span.start + (next.length - working.length));
    working = next;
  };

  let files: string[] = [];
  try {
    files = await fs.readdir(SYSTEM_PROMPTS_DIR);
  } catch {
    files = [];
  }
  for (const filename of files
    .filter(n => n.startsWith('inline-') && n.endsWith('.md'))
    .sort()) {
    const { content } = await applyInlineBlobOverrides(working, {
      only: filename,
    });
    let body = '';
    try {
      const raw = await fs.readFile(
        path.join(SYSTEM_PROMPTS_DIR, filename),
        'utf8'
      );
      body = matter(raw, { delimiters: ['<!--', '-->'] }).content;
    } catch {
      body = '';
    }
    record('inline-blob', filename, body, content);
  }

  for (const injection of REMINDER_REGISTRY) {
    const override = await loadReminderOverride(injection.id);
    // A missing file is what `--apply` seeds from the default body, so measure
    // the same span rather than skipping the reminder.
    const body = override ? override.body : injection.defaultBody;
    const isSuppressed = override ? override.isSuppressed : false;
    const { result, errors } = substitutePlaceholders(
      body,
      injection.placeholders
    );
    if (errors.length > 0) continue;
    let next: string | null = null;
    try {
      next = injection.apply(working, result, isSuppressed);
    } catch {
      next = null;
    }
    if (next === null) continue;
    record('reminder', injection.id, body, next);
  }

  return claims;
};

const dedupe = (findings: PreflightFinding[]): PreflightFinding[] => {
  const seen = new Set<string>();
  const out: PreflightFinding[] = [];
  for (const f of findings) {
    const key = [
      f.check,
      f.id,
      f.line ?? '',
      f.offending ?? '',
      f.message,
    ].join('\x00');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
};

export interface PreflightInput {
  /** cli.js as it is BEFORE any override splicing. */
  pristine: string;
  version: string;
  patchFilter?: string[] | null;
}

export const runSystemPromptPreflight = async ({
  pristine,
  version,
  patchFilter,
}: PreflightInput): Promise<PreflightResult> => {
  const findings: PreflightFinding[] = [];
  const escapeNonAscii = detectUnicodeEscaping(pristine);
  const buildTime = extractBuildTime(pristine);

  const prompts = await loadSystemPromptsWithRegex(
    version,
    escapeNonAscii,
    buildTime
  );
  // No prompt data preloaded for this version: the apply will skip system
  // prompts entirely, so there is nothing to validate. The CLI turns this into
  // a hard failure — a dry run that saw no input must never read as clean —
  // while the apply just carries on.
  if (prompts.length === 0) {
    return { version, promptsChecked: 0, sitesChecked: 0, findings: [] };
  }
  const bodiesById = await pristineBodiesById(version);

  // Catalogue entries that share a content shape share a candidate set: the
  // apply consumes them sequentially, one site per entry. Group by the search
  // regex so cardinality is measured per shape, never deduped by id — same-id
  // multi-site prompts are normal and load-bearing.
  const groups = new Map<
    string,
    Array<{ order: number; entry: (typeof prompts)[number] }>
  >();
  prompts.forEach((entry, order) => {
    if (patchFilter && !patchFilter.includes(entry.promptId)) return;
    const group = groups.get(entry.regex);
    if (group) group.push({ order, entry });
    else groups.set(entry.regex, [{ order, entry }]);
  });

  const promptClaims: Array<{ order: number; claim: SpanClaim }> = [];
  let sitesChecked = 0;

  for (const [regex, entries] of groups) {
    const multiplicity = entries.length;
    const matches = await findAllMatchesWithStackFallback(
      regex,
      'sig',
      pristine
    );
    const candidates = resolveCandidateSites(pristine, matches, multiplicity);

    if (candidates.length !== multiplicity) {
      const ids = [...new Set(entries.map(e => e.entry.promptId))].join(', ');
      findings.push({
        check: 'cardinality',
        severity: 'warning',
        id: entries[0].entry.promptId,
        site: 0,
        message:
          `${candidates.length} candidate site(s) in cli.js for ` +
          `${multiplicity} catalogue entr${multiplicity === 1 ? 'y' : 'ies'} ` +
          `(${ids}) — the apply consumes one site per entry, so this ` +
          (candidates.length < multiplicity
            ? 'leaves entries with no site to splice'
            : 'leaves the extra site(s) ambiguous'),
      });
    }

    for (let site = 0; site < entries.length; site++) {
      const { order, entry } = entries[site];
      const match = candidates[site];
      if (!match || match.index === undefined) continue;
      sitesChecked++;

      const delimiter = delimiterBefore(pristine, match.index);
      const body = entry.prompt.content;

      // Check 4 — delimiter-aware backtick lint, at the RESOLVED site with the
      // delimiter the resolution already determined. Quoted sites double every
      // backslash on the way in, so the same bytes are correct there.
      if (delimiter === '`') {
        for (const lint of lintBacktickEscapes(body)) {
          findings.push({
            check: 'backtick-escape',
            severity: lint.kind === 'lossy' ? 'error' : 'warning',
            id: entry.promptId,
            site,
            line: entry.prompt.contentLineOffset + lint.line,
            lineText: lint.lineText,
            offending: lint.offending,
            required: lint.required,
            message:
              lint.kind === 'lossy'
                ? `\`${lint.offending}\` at a backtick site is consumed by ` +
                  `the template literal (\`\\s\` cooks to \`s\`, ` +
                  `\`[\\s\\S]\` to \`[sS]\`) — write \`${lint.required}\` ` +
                  'for a literal backslash'
                : `\`${lint.offending}\` at a backtick site is a redundant ` +
                  'escape: the backslash is dropped and the quote renders as ' +
                  'written. Drop the backslash, or double it to keep one',
          });
        }
      }

      const encoded = encodeReplacementForDelimiter(
        entry.getInterpolatedContent(match),
        delimiter,
        escapeNonAscii
      );
      const pristineSite = pristine.slice(
        match.index,
        match.index + match[0].length
      );

      // Check 5 — raw non-ASCII the splice would introduce. Compared against
      // the canonical pristine body rather than the encoded site, so a
      // codepoint Anthropic already ships is never reported.
      const pristineBodies = bodiesById.get(entry.promptId);
      const pristineText = pristineBodies
        ? [...pristineBodies].join('\n')
        : pristineSite;
      const introduced = introducedRawNonAscii(pristineText, encoded.content);
      if (introduced.length > 0) {
        findings.push({
          check: 'raw-non-ascii',
          severity: 'error',
          id: entry.promptId,
          site,
          offending: introduced.join(' '),
          message:
            `would introduce raw non-ASCII ${introduced.join(' ')} the ` +
            'pristine text does not carry — Bun stores modules as Latin-1, so ' +
            'raw bytes mojibake; emit \\uXXXX instead',
        });
      }

      promptClaims.push({
        order,
        claim: {
          start: match.index,
          end: match.index + match[0].length,
          surface: 'prompt',
          id: entry.promptId,
          site,
          mutates: encoded.content !== pristineSite,
          body,
        },
      });
    }
  }

  // Check 3 — ownership. Claims in APPLY order: inline blobs, then reminders,
  // then named prompts in catalogue order. A region an earlier surface rewrites
  // stops matching, so the later override is dropped — silently, by design.
  // That is fine when the loser is a pristine passthrough and a problem when it
  // carries authored content that will never reach the model.
  const claims: SpanClaim[] = [
    ...(await claimOverrideSurfaces(pristine)),
    ...promptClaims.sort((a, b) => a.order - b.order).map(c => c.claim),
  ];

  const shadowDeclarations = await loadShadowDeclarations();
  const shadowedBy = (owner: string, victim: string): boolean =>
    shadowDeclarations.get(owner)?.has(victim) ?? false;

  for (const { claim, owner } of spanConflicts(claims, shadowedBy)) {
    findings.push({
      check: 'ownership',
      severity: 'warning',
      id: claim.id,
      site: claim.site,
      message:
        `${claim.surface} "${claim.id}" [${claim.start}, ${claim.end}) is ` +
        `already owned by ${owner.surface} "${owner.id}" [${owner.start}, ` +
        `${owner.end}), which the apply splices first — this override's ` +
        'authored content never reaches the binary. Declare `shadows:` on ' +
        'the owner, or narrow one of them',
    });
  }

  return {
    version,
    promptsChecked: prompts.length,
    sitesChecked,
    findings: dedupe(findings),
  };
};

export const formatPreflightFinding = (f: PreflightFinding): string => {
  const where = f.line !== undefined ? `${f.id}.md:${f.line}` : f.id;
  const head = `[${f.check}] ${where} (site ${f.site}): ${f.message}`;
  return f.lineText === undefined
    ? head
    : `${head}\n    ${f.lineText.trim().slice(0, 200)}`;
};
