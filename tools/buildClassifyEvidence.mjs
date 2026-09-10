#!/usr/bin/env node
// Builds the enriched exact-site packets the classify-and-name-prompts workflow
// reads. Without them a classifier agent has only the string's wording, and
// wording is not evidence of facing — the emission site is. Each packet pins a
// candidate to byte offsets in the pristine bundle, quotes the surrounding
// minified code, and carries the Piebald and previous-version bodies the agent
// would otherwise have to hunt for.
//
//   node tools/buildClassifyEvidence.mjs <cli.js> <prev-prompts.json> [piebald.json] [outDir]
//
// Reads /tmp/classify-chunk-NN.json, writes <outDir>/classify-evidence-NN.json.
import fs from 'node:fs';
import path from 'node:path';

const [cliPath, prevJsonPath, piebaldPath, outDirArg] = process.argv.slice(2);
if (!cliPath || !prevJsonPath) {
  console.error(
    'usage: buildClassifyEvidence.mjs <cli.js> <prev-prompts.json> [piebald.json] [outDir]'
  );
  process.exit(2);
}
const outDir = outDirArg || '/tmp';
const code = fs.readFileSync(cliPath, 'utf8');

const bodyOf = p =>
  (p.pieces || []).filter(x => typeof x === 'string').join('') ||
  p.content ||
  '';

const readPrompts = f => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).prompts || [];
  } catch {
    return [];
  }
};

const prevById = new Map();
for (const p of readPrompts(prevJsonPath)) {
  if (p.id && !prevById.has(p.id)) prevById.set(p.id, bodyOf(p));
}

// Exact-body index over Piebald's catalogue: when a candidate's body matches one
// of theirs byte for byte, their id is the right id and the agent should not
// mint a new one.
const piebaldByBody = new Map();
if (piebaldPath && fs.existsSync(piebaldPath)) {
  for (const p of readPrompts(piebaldPath)) {
    if (!p.id) continue;
    const b = bodyOf(p);
    if (b && !piebaldByBody.has(b))
      piebaldByBody.set(b, {
        id: p.id,
        name: p.name || '',
        desc: p.description || '',
      });
  }
}

// The bundle stores prompt text inside JS string literals, so a body's real
// newline is a two-character \n on disk and a template literal keeps it raw.
// Non-ASCII is emitted as \uXXXX, so an em dash or ellipsis anywhere in a run
// makes the raw form unfindable. Try every encoding rather than assuming a
// delimiter.
const escapeCtl = s =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
const escapeUnicode = s =>
  s.replace(
    /[^\x20-\x7e]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );

const encodings = [
  ['raw', s => s],
  ['escaped', escapeCtl],
  ['unicode', s => escapeUnicode(s)],
  ['escaped+unicode', s => escapeUnicode(escapeCtl(s))],
];

// Literal runs are the parts of a body that survive verbatim into the bundle;
// everything inside ${...} is an interpolation whose text is minified away.
// A run's longest pure-ASCII segment is also tried, because it is immune to
// whichever unicode-escaping convention this build used.
const literalRuns = body => {
  const runs = body
    .split(/\$\{[^}]*\}/g)
    .map(s => s.trim())
    .filter(s => s.length >= 24);
  const asciiSegments = [];
  for (const r of runs) {
    for (const seg of r.split(/[^\x20-\x7e]+/)) {
      const t = seg.trim();
      if (t.length >= 24) asciiSegments.push(t);
    }
  }
  return [...new Set([...runs, ...asciiSegments])].sort(
    (a, b) => b.length - a.length
  );
};

function locate(body) {
  for (const run of literalRuns(body).slice(0, 12)) {
    for (const [enc, fn] of encodings) {
      const needle = fn(run).slice(0, 200);
      if (needle.length < 24) continue;
      const at = code.indexOf(needle);
      if (at < 0) continue;
      let occurrences = 0;
      let from = 0;
      for (;;) {
        const i = code.indexOf(needle, from);
        if (i < 0) break;
        occurrences++;
        from = i + 1;
        if (occurrences > 20) break;
      }
      return { at, enc, needle, occurrences };
    }
  }
  return null;
}

const chunkFiles = fs
  .readdirSync('/tmp')
  .filter(f => /^classify-chunk-\d+\.json$/.test(f))
  .sort();
if (!chunkFiles.length) {
  console.error('no /tmp/classify-chunk-NN.json files found');
  process.exit(2);
}

// Packets left over from an earlier bump are indistinguishable from this one's:
// they are well-formed, full of real hashes, and a fan-out aimed at a counted
// range harvests them as a complete, plausible, wrong verdict set. The chunk
// writer already clears its own output; this one did not.
const keep = new Set(
  chunkFiles.map(f => f.replace('classify-chunk-', 'classify-evidence-'))
);
// Namespacing packets per version is what stops a previous bump's leftovers
// being harvested as this run's result, and that means outDir routinely does
// not exist yet. Same class as the buildAuditPacket ENOENT.
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) {
  if (/^classify-evidence-\d+\.json$/.test(f) && !keep.has(f)) {
    fs.unlinkSync(path.join(outDir, f));
    console.log(`removed stale packet from an earlier run: ${f}`);
  }
}

let located = 0;
let total = 0;
const written = [];
for (const cf of chunkFiles) {
  const cands = JSON.parse(fs.readFileSync(path.join('/tmp', cf), 'utf8'));
  const packets = cands.map(c => {
    total++;
    const hit = locate(c.body);
    if (hit) located++;
    const packet = {
      hash: c.hash,
      len: c.len,
      source: c.source || 'captured',
      bodyPreview: c.body.slice(0, 400),
      site: hit
        ? {
            offset: hit.at,
            encoding: hit.enc,
            occurrencesInBundle: hit.occurrences,
            matchedLiteral: hit.needle,
            // Enough minified code either side to read the enclosing call,
            // registration object, or push into a message array.
            before: code.slice(Math.max(0, hit.at - 900), hit.at),
            after: code.slice(
              hit.at + hit.needle.length,
              hit.at + hit.needle.length + 700
            ),
          }
        : null,
      searchHint: hit
        ? null
        : `not located automatically — grep ${cliPath} for a distinctive run of this body yourself`,
    };
    const pie = piebaldByBody.get(c.body);
    if (pie) packet.piebaldExact = pie;
    if (c.reusedFrom) {
      packet.reusedFrom = c.reusedFrom;
      const old = prevById.get(c.reusedFrom.id);
      if (old) packet.reusedFromOldBody = old;
    }
    if (c.possibleSuccessorOf) {
      packet.possibleSuccessorOf = c.possibleSuccessorOf;
      const old = prevById.get(c.possibleSuccessorOf.id);
      if (old) packet.possibleSuccessorOldBody = old;
    }
    return packet;
  });
  const of = path.join(
    outDir,
    cf.replace('classify-chunk-', 'classify-evidence-')
  );
  fs.writeFileSync(of, JSON.stringify(packets, null, 1));
  written.push(of);
}

console.log(
  `evidence packets: ${written.length} file(s), ${total} candidate(s)`
);
console.log(`emission site located: ${located}/${total}`);
for (const w of written) console.log(`  ${w}`);
