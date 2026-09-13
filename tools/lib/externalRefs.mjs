// Text in a prompt that something OUTSIDE the prompt depends on. Such text reads
// like prose — a label, an opening phrase, a clause — and nothing in the prompt's
// own body says it is load-bearing, which is why an audit trims it. On CC 2.1.267
// stage 1 proposed three such cuts in one batch:
//
//   - "SECURITY WARNING:" on two hand-back results, as CAPS theater — but a third
//     result tells the parent the report arrived "under a SECURITY WARNING from
//     auto mode — the warning above the report says why";
//   - a wipe of the hand-back report-via-tool reminder, whose body OPENS with a
//     slot holding the const `kln()` matches with startsWith() to decide reminder
//     vs countermand on resume.
//
// Three kinds are computable, so the packet carries them instead of hoping an
// agent greps for them:
//
//   rewriteNeedles  — rewrite-table needles (`fn(x,[[needle,replacement]])`) the
//                     pristine contains; the binary matches them against the
//                     override's own text.
//   quotedElsewhere — CAPS labels and [bracketed] markers this prompt emits that
//                     another catalogued prompt names.
//   predicateRuns   — literal runs the bundle passes straight to
//                     startsWith/includes/endsWith.
//   opensWithSlot   — the body starts with an interpolation; its value may be a
//                     key some detector matches the rendered text against.
//   rewriteReplacement — the body IS the replacement half of a rewrite pair.
//                     CC splices it into the middle of another rendered
//                     sentence, so a wipe deletes words from that sentence
//                     (CC 2.1.269: stage 1 proposed wiping "one the person can
//                     open, in their organization", which would have left the
//                     from_url description reading "must be ones ").
//
// All five are leads, not verdicts: text on these lists is FROZEN
// (verbatim-or-keep), and a wipe needs the lead checked in the bundle first.

const LABEL_RE = /\b[A-Z][A-Z0-9_-]{1,}(?: [A-Z][A-Z0-9_-]{1,})+\b/g;
const BRACKET_RE = /\[[^\]\n${}]{3,60}\]/g;
// A label that appears in more prompts than this is vocabulary, not a
// cross-reference (SOFT BLOCK, API, JSON …): listing it adds noise, not signal.
const GENERIC_LIMIT = 12;

export const literalRuns = body =>
  body
    .split(/\$\{[^}]*\}/)
    .map(s => s.trim())
    .filter(s => s.length >= 10);

export const externalRefs = ({
  id,
  bodies,
  corpus,
  needles = [],
  replacements = [],
  src = null,
}) => {
  const own = bodies.join('\n');
  const rewriteNeedles = needles.filter(n => own.includes(n));

  const labels = new Set();
  for (const re of [LABEL_RE, BRACKET_RE]) {
    for (const m of own.matchAll(re)) if (m[0].length >= 8) labels.add(m[0]);
  }
  const quotedElsewhere = [];
  for (const text of labels) {
    const others = [];
    for (const [otherId, otherBody] of corpus) {
      if (otherId === id || !otherBody.includes(text)) continue;
      others.push(otherId);
      if (others.length > GENERIC_LIMIT) break;
    }
    if (others.length && others.length <= GENERIC_LIMIT) {
      quotedElsewhere.push({ text, by: others.slice(0, 3) });
    }
  }

  const predicateRuns = [];
  if (src) {
    for (const run of literalRuns(own)) {
      for (const probe of [run, run.slice(0, 40)]) {
        if (probe.length < 10) continue;
        const esc = JSON.stringify(probe).slice(1, -1);
        const hit = ['startsWith(', 'includes(', 'endsWith('].some(fn =>
          ['"', "'", '`'].some(q => src.includes(`.${fn}${q}${esc}`))
        );
        if (hit) {
          predicateRuns.push(probe);
          break;
        }
      }
    }
  }

  return {
    rewriteNeedles,
    quotedElsewhere,
    predicateRuns,
    opensWithSlot: bodies.some(b => b.trimStart().startsWith('${')),
    rewriteReplacement: bodies.some(b => replacements.includes(b.trim())),
  };
};
