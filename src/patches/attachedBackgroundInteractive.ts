// Please see the note about writing patches in ./index
//
// Attached Background Interactive Patch - let a background session that a
// client is attached to offer what an interactive session offers.
//
// Claude Code tells the two cases apart itself. Beside the session-kind reader
// it defines both:
//
//   function VB(){let e=a.CLAUDE_CODE_SESSION_KIND;if(e==="bg"||...)return e;return}
//   function Lt(){return VB()==="bg"}           // a background session at all
//   function Vu(){return Lt()&&!Ou()}           // ...with nobody attached
//
// where `Ou()` is the attached client's capabilities (null with none attached).
// Several features use `Vu` and work while someone is attached (the refusal
// fallback switch, MCP OAuth scope prompts, and the session-kind line that
// reads "background job · unattended"). Others still test `Lt` and turn off for
// every background session, though each turns off only because nobody may be
// there to answer. This patch moves those to `Vu`:
//
//   1. ProposeGoal: its isEnabled and its call guard (`ve()||$n()||Lt()`).
//      The tool still needs its `tengu_propose_goal` flag, which is served by
//      GrowthBook or forced on by the separate propose-goal patch.
//   2. The usage-limit auto-resume offer (`autoContinueAtUsageLimit`,
//      `tengu_marble_heron`): `function SBt(){return fp()&&!Lt()&&!Dt()}`.
//   3. Its auto-continuation prompt after the limit resets:
//      `function yft(){return ...&&!$n()&&!Lt()}`.
//   4. Auto mode's prompt for a read outside the working directories:
//      `if(Lt()||v0e())return!1;if(!Rn("userSettings"))return!1;
//       return!s.session.outsideReadPrompt...`.
//   5. The workflow usage consent prompt (`workflowNeedsUsageConsentPrompt`):
//      `if(Lt())return!1;if(v0e())return!1;...workflowUsageConsent...`.
//
// ProposeGoal's isEnabled is read when the session assembles its tool pool,
// and the session keeps that pool while a key of its inputs is unchanged
// (`computeToolPool`'s `toolPoolCache`, compared field by field). A
// background session assembles it as it starts, before anyone attaches, so
// the key also gets the unattended predicate's answer: the first request after
// a client attaches or detaches assembles the pool again. ProposeGoal is a
// deferred tool, so it changes the deferred-tools announcement, not the tool
// array a request's cached prefix holds.
//
// `Lt` itself is untouched: the job directory, detach and takeover, the
// session's own restart refusal, telemetry and the request headers all need
// the real kind. A session nobody is attached to behaves exactly as before.
//
// Each site lives in its own bundle module. The native build links a module's
// imports from records made when it was compiled, so a name added to a site's
// import list is never bound ("is not defined" at the first call). The
// predicate reaches the sites as fablePlan's resolver reaches its effort
// lookup: a `globalThis` property set beside the definition, in the module
// every site already imports `Lt` from, so it is set before any site runs.

import { debug } from '../utils';
import { escapeIdent, showDiff } from './index';

// `__tweakcc` is the repo's patched-binary marker prefix.
const BRIDGE = 'globalThis.__tweakccUnattendedBg';
const BRIDGE_PATTERN = BRIDGE.replace('.', '\\.');

interface Predicates {
  background: string;
  unattended: string;
  // Offset just past the unattended predicate's definition.
  definedEnd: number;
}

/** The two predicates, by their definitions beside the session-kind reader. */
const findPredicates = (file: string): Predicates | null => {
  const pattern =
    /function ([$\w]+)\(\)\{let [$\w]+=[$\w]+\.CLAUDE_CODE_SESSION_KIND;[^}]*\}function ([$\w]+)\(\)\{return \1\(\)==="bg"\}/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: attachedBackgroundInteractive: failed to find the background session predicate'
    );
    return null;
  }
  const background = match[2];
  // Declared in the same run of functions, before the next module begins.
  const after = match.index + match[0].length;
  const nextModule = file.indexOf('/*@@TWEAKCC_MODULE:', after);
  const unattended = new RegExp(
    `function ([$\\w]+)\\(\\)\\{return ${escapeIdent(background)}\\(\\)&&![$\\w]+\\(\\)\\}`
  ).exec(file.slice(after, nextModule === -1 ? undefined : nextModule));
  if (!unattended) {
    console.error(
      'patch: attachedBackgroundInteractive: failed to find the unattended background predicate'
    );
    return null;
  }
  return {
    background,
    unattended: unattended[1],
    definedEnd: after + unattended.index + unattended[0].length,
  };
};

/** Publish the unattended predicate on `globalThis` beside its definition. */
const publishUnattended = (file: string, p: Predicates): string => {
  const insertion = `${BRIDGE}=${p.unattended};`;
  if (file.startsWith(insertion, p.definedEnd)) {
    debug('patch: attachedBackgroundInteractive: predicate already published');
    return file;
  }
  const newFile =
    file.slice(0, p.definedEnd) + insertion + file.slice(p.definedEnd);
  showDiff(file, newFile, insertion, p.definedEnd, p.definedEnd);
  return newFile;
};

interface Site {
  name: string;
  // Matches the site patched or unpatched: capture 1 is the text before the
  // predicate call, capture 2 the callee.
  pattern: (p: Predicates) => RegExp;
}

const either = (p: Predicates): string =>
  `(${escapeIdent(p.background)}|${BRIDGE_PATTERN})`;

const SITES: Site[] = [
  {
    name: 'ProposeGoal isEnabled',
    pattern: p =>
      new RegExp(
        `(isEnabled\\(\\)\\{if\\([$\\w]+\\(\\)\\|\\|[$\\w]+\\(\\)\\)return!1;if\\()${either(p)}(\\(\\)\\)return!1;if\\(![$\\w]+\\(\\)\\)return!1;let [$\\w]+=[$\\w]+\\(\\);if\\([$\\w]+==="disabled"\\))`
      ),
  },
  {
    name: 'ProposeGoal call guard',
    pattern: p =>
      new RegExp(
        `(if\\([$\\w]+\\(\\)\\|\\|[$\\w]+\\(\\)\\|\\|)${either(p)}(\\(\\)\\)throw [$\\w]+\\("goal_propose","session_shape"\\))`
      ),
  },
  {
    name: 'usage-limit auto-resume offer',
    pattern: p =>
      new RegExp(
        `(var [$\\w]+="tengu_marble_heron";(?:(?!/\\*@@TWEAKCC_MODULE:)[^])*?function [$\\w]+\\(\\)\\{return [$\\w]+\\(\\)&&!)${either(p)}(\\(\\)&&![$\\w]+\\(\\)\\})`
      ),
  },
  {
    name: 'usage-limit auto-continuation',
    pattern: p =>
      new RegExp(
        `(function [$\\w]+\\(\\)\\{return [^{}]*?&&!)${either(p)}(\\(\\)\\}function [$\\w]+\\([$\\w]+\\)\\{return [$\\w]+\\(\\)&&[$\\w]+\\([$\\w]+\\)&&[$\\w]+\\.rateLimitType==="five_hour")`
      ),
  },
  {
    name: 'outside-read prompt',
    pattern: p =>
      new RegExp(
        `(if\\()${either(p)}(\\(\\)\\|\\|[$\\w]+\\(\\)\\)return!1;if\\(![$\\w]+\\("userSettings"\\)\\)return!1;return![$\\w]+\\.session\\.outsideReadPrompt)`
      ),
  },
  {
    name: 'workflow usage consent prompt',
    pattern: p =>
      new RegExp(
        `(if\\()${either(p)}(\\(\\)\\)return!1;if\\([$\\w]+\\(\\)\\)return!1;if\\([$\\w]+\\([$\\w]+\\([$\\w]+\\),[$\\w]+\\.options\\.mainLoopModel\\)\\)return!1;return![$\\w]+\\.session\\.workflowUsageConsent)`
      ),
  },
];

const patchSite = (file: string, site: Site, p: Predicates): string | null => {
  const match = file.match(site.pattern(p));
  if (!match || match.index === undefined) {
    console.error(
      `patch: attachedBackgroundInteractive: failed to find the ${site.name}`
    );
    return null;
  }
  if (match[2] === BRIDGE) {
    debug(`patch: attachedBackgroundInteractive: ${site.name} already patched`);
    return file;
  }
  const callAt = match.index + match[1].length;
  const newFile =
    file.slice(0, callAt) + BRIDGE + file.slice(callAt + match[2].length);
  showDiff(file, newFile, BRIDGE, callAt, callAt + match[2].length);
  return newFile;
};

const KEY_FIELD = 'unattendedBg';

/**
 * The tool pool's cache key gains the unattended predicate's answer:
 *   computeToolPool(h,E,D){let L={toolPermissionContext:...,
 *     waitForMcpServersDeclared:xWe()},Q=this.toolPoolCache;
 *     if(Q!==null&&hbt(Q.key,L))return Q.result;...
 * and the key comparison compares it:
 *   function hbt(h,E){return h.toolPermissionContext===E.toolPermissionContext
 *     &&...&&h.waitForMcpServersDeclared===E.waitForMcpServersDeclared}
 */
const patchToolPoolKey = (file: string): string | null => {
  const key = file.match(
    /(waitForMcpServersDeclared:[$\w]+\(\))(,unattendedBg:[^}]*)?(\},[$\w]+=this\.toolPoolCache;)/
  );
  const compare = file.match(
    /function [$\w]+\(([$\w]+),([$\w]+)\)\{return \1\.toolPermissionContext===\2\.toolPermissionContext[^}]*?&&\1\.waitForMcpServersDeclared===\2\.waitForMcpServersDeclared(&&\1\.unattendedBg===\2\.unattendedBg)?\}/
  );
  if (
    !key ||
    key.index === undefined ||
    !compare ||
    compare.index === undefined
  ) {
    console.error(
      'patch: attachedBackgroundInteractive: failed to find the tool pool cache key'
    );
    return null;
  }
  if (key[2] && compare[3]) return file;
  const [h, e] = [compare[1], compare[2]];
  const keyAt = key.index + key[1].length;
  const edits: [number, string][] = [
    [keyAt, `,${KEY_FIELD}:${BRIDGE}()`],
    [
      compare.index + compare[0].length - 1,
      `&&${h}.${KEY_FIELD}===${e}.${KEY_FIELD}`,
    ],
  ];
  // Back to front, so each insertion leaves the other's offset as found.
  let newFile = file;
  for (const [at, text] of edits.sort((x, y) => y[0] - x[0])) {
    newFile = newFile.slice(0, at) + text + newFile.slice(at);
  }
  showDiff(file, newFile, edits[0][1], keyAt, keyAt);
  return newFile;
};

export const writeAttachedBackgroundInteractive = (
  oldFile: string
): string | null => {
  const predicates = findPredicates(oldFile);
  if (!predicates) return null;
  // An edit earlier in the bundle moves the definition, so the publication
  // goes in last, at a fresh search's offset.
  let file = oldFile;
  for (const site of SITES) {
    const next = patchSite(file, site, predicates);
    if (next === null) return null;
    file = next;
  }
  const keyed = patchToolPoolKey(file);
  if (keyed === null) return null;
  const located = findPredicates(keyed);
  if (!located) return null;
  return publishUnattended(keyed, located);
};
