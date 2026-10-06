// Which tool-description/tool-parameter carriers are always-on.
//
// A tool's description is in every request only when the tool is offered up
// front. A DEFERRED tool (`shouldDefer:!0`) is absent from the request's
// tools[]; its description reaches the model through an earlier ToolSearch
// result, which compaction can drop. So a deferred tool's description is a
// conditional carrier, and its co-render with that tool's own tool_result is
// not proven. On CC 2.1.291 five trims cited WebFetch, ProposeGoal and
// OfferChromeSetup descriptions as always-on coverage; three verifiers refuted
// them and two passed, so the packets now say which is which.
//
// The authority is the turnProbe wire capture: the largest req-*.json carries
// the tools[] of a real interactive turn.
import fs from 'node:fs';
import path from 'node:path';

const TOOL_CARRIER = /^tool-(description|parameter)-/;
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const hasReqBodies = d => {
  try {
    return fs.readdirSync(d).some(f => /^req-.*\.json$/.test(f));
  } catch {
    return false;
  }
};

// TWEAKCC_CAPTURES, else the dir `driver check` recorded for the version
// (<tmp>/turnprobe-<ver>.json), else the newest <tmp>/turnprobe-<ver>-*/.
export const resolveCaptureDir = (version, { env = process.env, tmp = '/tmp' } = {}) => {
  if (env.TWEAKCC_CAPTURES) return hasReqBodies(env.TWEAKCC_CAPTURES) ? env.TWEAKCC_CAPTURES : null;
  if (!version) return null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(tmp, `turnprobe-${version}.json`), 'utf8'));
    if (st && typeof st.dir === 'string' && hasReqBodies(st.dir)) return st.dir;
  } catch {
    /* no recorded capture */
  }
  let best = null;
  try {
    for (const f of fs.readdirSync(tmp)) {
      if (!f.startsWith(`turnprobe-${version}-`)) continue;
      const d = path.join(tmp, f);
      if (!hasReqBodies(d)) continue;
      const m = fs.statSync(d).mtimeMs;
      if (!best || m > best.m) best = { d, m };
    }
  } catch {
    return null;
  }
  return best ? best.d : null;
};

// The tools[] of the largest captured request: names, and the JSON text the
// weak-key check searches.
export const capturedTools = dir => {
  const reqs = fs
    .readdirSync(dir)
    .filter(f => /^req-.*\.json$/.test(f))
    .map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  for (const f of reqs) {
    let body;
    try {
      body = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!body || !Array.isArray(body.tools) || !body.tools.length) continue;
    const names = body.tools.map(t => t && t.name).filter(Boolean);
    return { file: f, names, text: stringsOf(body.tools).join('\n') };
  }
  return null;
};

// Candidate tool keys for a carrier: every run of leading id tokens joined
// ("tool-description-web-fetch-x" -> web, webfetch, webfetchx …) and a
// CamelCase first word of its catalogue name ("Tool Description: WebFetch
// (concise)" -> webfetch). A key that is only the FIRST id token of a longer id
// is weak — "tool-description-read-mcp-resource" and
// "tool-description-read-console-messages-limit-param" are not the Read tool —
// so a weak match must also find a 25-char run of the carrier's text in the
// captured tools[]. A plain first word of a name ("Read console messages") is
// never a key.
const keysFor = (id, name) => {
  const toks = id.replace(TOOL_CARRIER, '').split('-').filter(Boolean);
  const strong = new Set();
  const weak = new Set();
  for (let i = 1; i <= toks.length; i++) {
    const k = norm(toks.slice(0, i).join('')).replace(/tool$/, '');
    if (!k) continue;
    (i === 1 && toks.length > 1 ? weak : strong).add(k);
  }
  const first = String(name || '')
    .replace(/^[^:]*:\s*/, '')
    .split(/[\s(]+/)[0];
  if (/^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(first || ''))
    strong.add(norm(first).replace(/tool$/, ''));
  return { strong, weak };
};

const stringsOf = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out);
  return out;
};
const runsOf = text =>
  String(text)
    .replace(/\\([`$\\])/g, '$1')
    .split(/\$\{[^}]*\}/)
    .map(r => r.replace(/\s+/g, ' ').trim())
    .filter(r => r.length >= 25);

// 'always-on': the carrier's tool is in the capture's tools[]. 'deferred': no
// key names an offered tool — the tool is not offered up front, a conditional
// carrier. 'unresolved': only a weak key names an offered tool and none of the
// carrier's text is in the capture (another tool sharing the prefix, or an arm
// this turn did not render) — the agent resolves it. null: not a tool
// description/parameter. textsOf(id) gives the carrier's DEPLOYED text (the
// capture comes from the patched binary); it is read only for weak keys.
export const makeToolStatus = (capture, nameOf = () => '', textsOf = () => []) => {
  if (!capture) return () => null;
  const offered = new Set(capture.names.map(n => norm(n).replace(/tool$/, '')));
  const flat = capture.text.replace(/\s+/g, ' ');
  return id => {
    if (!TOOL_CARRIER.test(id)) return null;
    const { strong, weak } = keysFor(id, nameOf(id));
    for (const k of strong) if (offered.has(k)) return 'always-on';
    if (![...weak].some(k => offered.has(k))) return 'deferred';
    for (const t of textsOf(id))
      for (const r of runsOf(t)) if (flat.includes(r.slice(0, 120))) return 'always-on';
    return 'unresolved';
  };
};

export const TOOL_STATUS_NOTE = {
  'always-on': "ALWAYS-ON tool (in the turnProbe capture's tools[])",
  deferred:
    "DEFERRED tool (not in the turnProbe capture's tools[]): a CONDITIONAL carrier — it reaches the model only through a ToolSearch result compaction can drop, so its co-render with this tool's own tool_result, a system prompt or another tool is NOT proven; only its own tool object's description/schema pieces co-render with it",
  unresolved:
    "tool UNRESOLVED from the id (a prefix names an offered tool but none of this text is in the turnProbe capture's tools[]): before citing it, find its tool object in the bundle — always-on only if that tool is in tools[]",
};

// One-line header for a packet: which tools the capture offers.
export const captureLine = (dir, capture) =>
  capture
    ? `Always-on tools (turnProbe capture ${path.basename(capture.file)} in ${dir}, tools[]): ${capture.names.join(', ')}. A tool-description-*/tool-parameter-* carrier of any other tool is DEFERRED or not offered: a conditional carrier.`
    : 'No turnProbe capture was found for this version, so tool carriers are not marked: a tool-description-*/tool-parameter-* carrier is always-on only if its tool is in a capture\'s tools[] — check before citing one.';
