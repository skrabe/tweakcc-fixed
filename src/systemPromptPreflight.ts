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
import { MutableText } from './mutableText';
import {
  findAllPromptPieceMatchesBatch,
  foldPromptMatchContent,
  PromptPieceMatcherCatalog,
  PromptMatchSpec,
} from './systemPromptPieceMatcher';
import {
  encodeReplacementForDelimiter,
  loadIdentifierMapUnion,
  loadSystemPromptsWithRegex,
  pristineBodiesById,
} from './systemPromptSync';
import {
  bodyCarriedBy,
  changedSpan,
  delimiterBefore,
  detectUnicodeEscaping,
  extractBuildTime,
  introducedRawNonAscii,
  leakedPromptPlaceholders,
  lintBacktickEscapes,
  literalProbeWindows,
  OffsetMapper,
  pickMatchForSpliceAt,
  presentLiterals,
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

export type PreflightSeverity = 'error' | 'warning' | 'info';

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

interface PromptLanding {
  regex: string;
  spec: PromptMatchSpec;
  sites: Array<{ start: number; end: number }>;
  order: number;
  getInterpolatedContent: (match: RegExpMatchArray) => string;
  shouldSkip: (interpolatedContent: string, delimiter: string) => boolean;
}

type PromptLandingMap = Map<SpanClaim, PromptLanding>;

const PROBE_RUN_MIN_LENGTH = 25;
const PROBE_RUN_MAX_LENGTH = 160;

interface SurfaceClaims {
  claims: SpanClaim[];
  content: string;
  mapper: OffsetMapper;
}

export interface PromptReplayPlan {
  claim: SpanClaim;
  regex: string;
  spec: PromptMatchSpec;
  order: number;
  getInterpolatedContent: (match: RegExpMatchArray) => string;
  shouldSkip?: (interpolatedContent: string, delimiter: string) => boolean;
}

export interface PromptReplayMutation {
  claim: SpanClaim;
  source: SpanClaim;
  regex: string;
  order: number;
}

export interface PromptReplayResult {
  content: string;
  landed: Map<SpanClaim, boolean>;
  destinations: Map<SpanClaim, { start: number; end: number }>;
  replacements: Map<SpanClaim, string>;
  delimiters: Map<SpanClaim, string>;
  mutations: PromptReplayMutation[];
}

export const replayPromptPlans = async (
  content: string,
  mapper: OffsetMapper,
  plans: PromptReplayPlan[],
  escapeNonAscii: boolean
): Promise<PromptReplayResult> => {
  const working = new MutableText(content);
  const catalog = new PromptPieceMatcherCatalog([
    ...new Map(plans.map(plan => [plan.regex, plan.spec])).values(),
  ]);
  catalog.index(content, foldPromptMatchContent(content));
  const landed = new Map<SpanClaim, boolean>();
  const destinations = new Map<SpanClaim, { start: number; end: number }>();
  const replacements = new Map<SpanClaim, string>();
  const delimiters = new Map<SpanClaim, string>();
  const mutations: PromptReplayMutation[] = [];
  const orderedPlans = [...plans].sort((a, b) => a.order - b.order);
  const lastUse = new Map<string, number>();
  orderedPlans.forEach((plan, index) => lastUse.set(plan.regex, index));
  const expiring = new Map<number, string[]>();
  for (const [regex, index] of lastUse) {
    const regexes = expiring.get(index);
    if (regexes) regexes.push(regex);
    else expiring.set(index, [regex]);
  }
  for (const [planIndex, plan] of orderedPlans.entries()) {
    for (const expired of expiring.get(planIndex - 1) ?? []) {
      catalog.delete(expired);
    }
    const matches = await catalog.matchCurrent(plan.regex, working);
    const { match } = pickMatchForSpliceAt(matches, index =>
      working.charAt(index)
    );
    if (!match || match.index === undefined) {
      landed.set(plan.claim, false);
      continue;
    }
    const span = {
      start: match.index,
      end: match.index + match[0].length,
    };
    const delimiter = working.charAt(span.start - 1);
    const interpolatedContent = plan.getInterpolatedContent(match);
    if (plan.shouldSkip?.(interpolatedContent, delimiter)) {
      landed.set(plan.claim, false);
      continue;
    }
    const encoded = encodeReplacementForDelimiter(
      interpolatedContent,
      delimiter,
      escapeNonAscii
    );
    if (encoded.incomplete) {
      landed.set(plan.claim, false);
      continue;
    }
    landed.set(plan.claim, true);
    replacements.set(plan.claim, encoded.content);
    delimiters.set(plan.claim, delimiter);
    if (encoded.content === match[0]) {
      destinations.set(plan.claim, span);
      continue;
    }
    const actualClaim: SpanClaim = {
      ...plan.claim,
      ...mapper.spanToPristine(span),
      mutates: true,
      replacement: encoded.content,
    };
    const delta = encoded.content.length - (span.end - span.start);
    for (const destination of destinations.values()) {
      if (destination.end <= span.start) continue;
      if (destination.start >= span.end) {
        destination.start += delta;
        destination.end += delta;
        continue;
      }
      destination.start = Math.min(destination.start, span.start);
      destination.end = Math.max(
        span.start + encoded.content.length,
        destination.end + delta
      );
    }
    working.splice(span.start, span.end, encoded.content);
    mapper.record(span, encoded.content.length);
    catalog.recordSplice(working, {
      start: span.start,
      end: span.end,
      replacementLength: encoded.content.length,
    });
    destinations.set(plan.claim, {
      start: span.start,
      end: span.start + encoded.content.length,
    });
    mutations.push({
      claim: actualClaim,
      source: plan.claim,
      regex: plan.regex,
      order: plan.order,
    });
  }
  return {
    content: working.toString(),
    landed,
    destinations,
    replacements,
    delimiters,
    mutations,
  };
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
): Promise<SurfaceClaims> => {
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
    const newLen = span.end - span.start + (next.length - working.length);
    const claim: SpanClaim = {
      ...mapper.spanToPristine(span),
      surface,
      id,
      site: 0,
      mutates: true,
      body,
      delimiter: '',
      replacement: next.slice(span.start, span.start + newLen),
    };
    claims.push(claim);
    mapper.record(span, newLen);
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

  return { claims, content: working, mapper };
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
  const identifierMapUnion = await loadIdentifierMapUnion();
  const groupNames = new Map<string, Set<string>>();
  for (const entry of prompts) {
    const names = groupNames.get(entry.promptId) ?? new Set<string>();
    for (const name of Object.values(entry.identifierMap)) names.add(name);
    groupNames.set(entry.promptId, names);
  }

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
  const promptLandings: PromptLandingMap = new Map();
  let sitesChecked = 0;
  const groupMatches = await findAllPromptPieceMatchesBatch(
    [...groups].map(([regex, entries]) => ({
      regex,
      pieces: entries[0].entry.pieces,
      version,
      buildTime,
    })),
    pristine,
    foldPromptMatchContent(pristine)
  );

  for (const [regex, entries] of groups) {
    const multiplicity = entries.length;
    const matches = groupMatches.get(regex) ?? [];
    const candidates = resolveCandidateSites(pristine, matches, multiplicity);
    const landingSites = candidates.flatMap(match =>
      match.index === undefined
        ? []
        : [
            {
              start: match.index,
              end: match.index + match[0].length,
            },
          ]
    );

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

      const interpolatedContent = entry.getInterpolatedContent(match);
      const shouldSkip = (content: string, siteDelimiter: string): boolean => {
        const leaked = leakedPromptPlaceholders(
          content,
          entry.prompt.content,
          identifierMapUnion
        );
        const ownNames = new Set(Object.values(entry.identifierMap));
        const siblingNames = groupNames.get(entry.promptId);
        const siblingShape =
          leaked.length > 0 &&
          leaked.every(name => !ownNames.has(name) && siblingNames?.has(name));
        return siblingShape || (siteDelimiter === '`' && leaked.length > 0);
      };
      const encoded = encodeReplacementForDelimiter(
        interpolatedContent,
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

      const claim: SpanClaim = {
        start: match.index,
        end: match.index + match[0].length,
        surface: 'prompt',
        id: entry.promptId,
        site,
        mutates:
          !shouldSkip(interpolatedContent, delimiter) &&
          encoded.content !== pristineSite,
        body,
        delimiter,
        replacement: encoded.content,
      };
      promptLandings.set(claim, {
        regex,
        spec: { regex, pieces: entry.pieces, version, buildTime },
        sites: landingSites,
        order,
        getInterpolatedContent: entry.getInterpolatedContent,
        shouldSkip,
      });
      promptClaims.push({ order, claim });
    }
  }

  const surfaces = await claimOverrideSurfaces(pristine);
  const orderedPromptClaims = promptClaims
    .sort((a, b) => a.order - b.order)
    .map(item => item.claim);
  const claims = [...surfaces.claims, ...orderedPromptClaims];
  const replayPlans = orderedPromptClaims.flatMap(claim => {
    const landing = promptLandings.get(claim);
    if (!landing) return [];
    return [
      {
        claim,
        regex: landing.regex,
        spec: landing.spec,
        order: landing.order,
        getInterpolatedContent: landing.getInterpolatedContent,
        shouldSkip: landing.shouldSkip,
      },
    ];
  });
  const replay = await replayPromptPlans(
    surfaces.content,
    surfaces.mapper,
    replayPlans,
    escapeNonAscii
  );

  const shadowDeclarations = await loadShadowDeclarations();
  const shadowedBy = (owner: string, victim: string): boolean =>
    shadowDeclarations.get(owner)?.has(victim) ?? false;
  const directOwners = new Map(
    spanConflicts(claims, shadowedBy).map(conflict => [
      conflict.claim,
      conflict.owner,
    ])
  );
  const surfaceMutations = surfaces.claims.map((claim, index) => ({
    claim,
    source: claim,
    regex: '',
    order: index - surfaces.claims.length,
  }));
  const mutations = [...surfaceMutations, ...replay.mutations];
  const candidates = replayPlans.flatMap(plan => {
    if (!plan.claim.mutates) return [];
    const landing = promptLandings.get(plan.claim)!;
    const physicalOwner = directOwners.get(plan.claim);
    if (physicalOwner) {
      return [{ claim: plan.claim, owner: physicalOwner, direct: true }];
    }
    if (replay.landed.get(plan.claim) !== false) return [];
    const eligible = mutations.filter(mutation => {
      if (
        mutation.order >= plan.order ||
        mutation.regex === plan.regex ||
        mutation.claim.id === plan.claim.id ||
        shadowedBy(mutation.claim.id, plan.claim.id) ||
        shadowedBy(plan.claim.id, mutation.claim.id)
      ) {
        return false;
      }
      return true;
    });
    const shifted = eligible.find(mutation =>
      landing.sites.some(
        site =>
          (mutation.claim.start < site.end &&
            site.start < mutation.claim.end) ||
          (mutation.source.start < site.end && site.start < mutation.source.end)
      )
    );
    if (shifted && bodyCarriedBy(plan.claim.body, shifted.claim.body))
      return [];
    return shifted
      ? [{ claim: plan.claim, owner: shifted.claim, direct: false }]
      : [];
  });

  const candidateRuns = new Map(
    candidates.map(candidate => [
      candidate.claim,
      literalProbeWindows(
        replay.replacements.get(candidate.claim) ?? candidate.claim.replacement,
        PROBE_RUN_MIN_LENGTH,
        PROBE_RUN_MAX_LENGTH,
        (replay.delimiters.get(candidate.claim) ??
          candidate.claim.delimiter) === '`'
      ),
    ])
  );
  const pristinePresence = presentLiterals(
    pristine,
    [...candidateRuns.values()].flat()
  );

  if (process.env.TWEAKCC_PREFLIGHT_DUMP) {
    await fs.writeFile(
      process.env.TWEAKCC_PREFLIGHT_DUMP + '.cands',
      candidates.map(c => `${c.claim.id} <- ${c.owner.id}`).join('\n')
    );
    await fs.writeFile(
      process.env.TWEAKCC_PREFLIGHT_DUMP + '.landings',
      replayPlans
        .map(
          plan =>
            `${plan.claim.id}[${plan.claim.site}]=${replay.landed.get(plan.claim)}`
        )
        .join('\n')
    );
    await fs.writeFile(
      process.env.TWEAKCC_PREFLIGHT_DUMP + '.mutations',
      mutations
        .map(
          mutation =>
            `${mutation.source.id}[${mutation.source.site}] -> ` +
            `[${mutation.claim.start},${mutation.claim.end})`
        )
        .join('\n')
    );
    await fs.writeFile(process.env.TWEAKCC_PREFLIGHT_DUMP, replay.content);
  }

  // A warning requires a >=25-character authored literal window that is absent
  // from pristine and from this site's final apply-order projection. Every
  // window is checked, so partial delivery still warns; backtick interpolation
  // slots are excluded because their bytes are runtime-dependent. With no such
  // distinctive window the result is info, never a claim that content was lost.
  for (const { claim, owner, direct } of candidates) {
    const cause = direct
      ? `${claim.surface} "${claim.id}" [${claim.start}, ${claim.end}) ` +
        `overlaps ${owner.surface} "${owner.id}" [${owner.start}, ` +
        `${owner.end}), which the apply splices first`
      : `${owner.surface} "${owner.id}" [${owner.start}, ${owner.end}) ` +
        `rewrites an earlier site before catalogue ordinal ${claim.site} of ` +
        `${claim.surface} "${claim.id}" can be consumed`;

    const destination = replay.destinations.get(claim);
    const projected = destination ?? surfaces.mapper.spanToCurrent(claim);
    const siteContent = replay.content.slice(projected.start, projected.end);
    const replacement = replay.replacements.get(claim) ?? claim.replacement;
    if (replacement.length > 0 && siteContent.includes(replacement)) {
      continue;
    }
    const runs = (candidateRuns.get(claim) ?? []).filter(
      run => !pristinePresence.has(run)
    );
    if (runs.length === 0) {
      findings.push({
        check: 'ownership',
        severity: 'info',
        id: claim.id,
        site: claim.site,
        message:
          `${cause}. Undecidable by content probe: every literal run this ` +
          `override writes is under ${PROBE_RUN_MIN_LENGTH} characters or ` +
          'already present in the pristine binary, so there is nothing ' +
          'distinctive to search the patched result for. Verify this one by ' +
          'hand',
      });
      continue;
    }
    const delivered = presentLiterals(siteContent, runs);
    const missing = runs.filter(run => !delivered.has(run));
    if (process.env.TWEAKCC_PREFLIGHT_DUMP) {
      await fs.writeFile(
        process.env.TWEAKCC_PREFLIGHT_DUMP + '.jsonl',
        JSON.stringify({
          id: claim.id,
          landed: replay.landed.get(claim) ?? false,
          present: runs.filter(run => !missing.includes(run)),
          missing,
        }) + '\n',
        { flag: 'a' }
      );
    }
    if (missing.length === 0) continue;

    findings.push({
      check: 'ownership',
      severity: 'warning',
      id: claim.id,
      site: claim.site,
      offending: missing[0].slice(0, 80),
      message:
        `${cause}. Authored text is absent from this site after exact ` +
        'apply-order replay — that content never reaches the model. Declare ' +
        '`shadows:` on the owner, align the two, or drop the redundant override',
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
