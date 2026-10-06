// Please see the note about writing patches in ./index
//
// Channels Mode Patch - Force-enable MCP channel notifications in Claude Code
//
// Channels let MCP servers push real-time notifications into a Claude Code
// session. The feature is gated by:
//
// 1. `tengu_harbor` — master on/off (GrowthBook, default false).
//    isChannelsEnabled() checks this; when false, --channels is a no-op.
//
// 2. `gateChannelServer()` — multi-layer gate that checks auth, org policy,
//    session opt-in (--channels), and allowlist. For server-kind entries
//    (server:name), the allowlist always fails unless entry.dev is true —
//    which only --dangerously-load-development-channels sets. This is why
//    channel users are forced into the dev flag + its confirmation dialog.
//
// 3. `tengu_harbor_permissions` — separate gate for permission-relay over
//    channels (lets a remote party approve tool use via a channel message).
//
// 4. ChannelsNotice — startup banner warning about "Experimental" status
//    and prompt injection risks, shown for every --channels session.
//
// This patch bypasses all of these so --channels works cleanly:
// no GrowthBook dependency, no allowlist, no dev flag, no warning.
//
// Patch 1 - Channels feature gate (tengu_harbor):
// ```diff
//  function qX_() {
// +  return !0;
//    return A9("tengu_harbor", !1);
//  }
// ```
//
// Patch 2 - gateChannelServer (allowlist/auth/policy bypass):
// Injects early return after the capability check so all remaining gates
// (auth, policy, session, allowlist) are skipped. Anchored on the unique
// capability-check reason string.
// ```diff
//  ...reason:"server did not declare claude/channel capability"};
// +return{action:"register"};
//  if(!isChannelsEnabled())...
// ```
//
// Patch 3 - Permission relay gate (tengu_harbor_permissions):
// ```diff
//  function pQ7() {
// +  return !0;
//    return A9("tengu_harbor_permissions", !1);
//  }
// ```
//
// Patch 4 - ChannelsNotice warning suppression:
// Replaces the "Experimental · prompt injection risks" banner text with
// a short neutral message.

import { showDiff } from './index';

/**
 * Patch 1: Bypass tengu_harbor flag — force isChannelsEnabled() to return true.
 *
 * Method 1 (CC >= 2.1.291): the gate also requires the allow_channels route:
 *   function aL(){return nn("allow_channels")&&k("tengu_harbor",!1)}
 * Method 2 (older CC): function qX_(){return A9("tengu_harbor",!1)}
 */
const patchChannelsEnabled = (file: string): string | null => {
  const patterns = [
    /function [$\w]+\(\)\{return [$\w]+\("allow_channels"\)&&[$\w]+\("tengu_harbor",!1\)/,
    /function [$\w]+\(\)\{return [$\w]+\("tengu_harbor",!1\)/,
  ];
  for (const pattern of patterns) {
    const match = file.match(pattern);
    if (!match || match.index === undefined) continue;

    const insertIndex = match.index + match[0].indexOf('{') + 1;
    const insertion = 'return !0;';

    const newFile =
      file.slice(0, insertIndex) + insertion + file.slice(insertIndex);

    showDiff(file, newFile, insertion, insertIndex, insertIndex);
    return newFile;
  }

  console.error('patch: channelsMode: failed to find tengu_harbor gate');
  return null;
};

/**
 * Patch 1b (CC >= 2.1.291, optional): the "disabled" probe. The startup
 * banner and the gate's `disabled` branch call a separate function that
 * returns true while tengu_harbor is off:
 *   function bdt(){if(!k("tengu_harbor",!1))return!0;let e=Nf("allow_channels");...}
 * Without forcing it false the banner reads "ignored (Channels are not
 * currently available)" even though the gates are bypassed. Absent in older
 * CC builds, so a miss is a no-op.
 */
const patchChannelsDisabledProbe = (file: string): string => {
  const pattern =
    /function [$\w]+\(\)\{if\(![$\w]+\("tengu_harbor",!1\)\)return!0;/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) return file;

  const insertIndex = match.index + match[0].indexOf('{') + 1;
  const insertion = 'return !1;';

  const newFile =
    file.slice(0, insertIndex) + insertion + file.slice(insertIndex);

  showDiff(file, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};

/**
 * Patch 2: Bypass gateChannelServer — inject return{action:"register"} after
 * the capability check so auth, policy, session, and allowlist gates are all
 * skipped. Without this, server-kind entries (server:name) always fail the
 * allowlist unless entry.dev is true (only set by the dev-channels flag).
 *
 * Anchored on the unique capability-check reason string that only appears in
 * gateChannelServer. We find the end of that return statement and insert
 * immediately after it.
 */
const patchGateFunction = (file: string): string | null => {
  const pattern =
    /reason:"server did not declare claude\/channel capability"\};?/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: channelsMode: failed to find gateChannelServer capability check'
    );
    return null;
  }

  const insertIndex = match.index + match[0].length;
  const insertion = 'return{action:"register"};';

  const newFile =
    file.slice(0, insertIndex) + insertion + file.slice(insertIndex);

  showDiff(file, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};

/**
 * Patch 3: Bypass tengu_harbor_permissions — force-enable permission relay
 * over channels so tool approval requests can be relayed via channel messages.
 */
const patchPermissionRelay = (file: string): string | null => {
  const pattern =
    /function [$\w]+\(\)\{return [$\w]+\("tengu_harbor_permissions",!1\)/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: channelsMode: failed to find tengu_harbor_permissions gate'
    );
    return null;
  }

  const insertIndex = match.index + match[0].indexOf('{') + 1;
  const insertion = 'return !0;';

  const newFile =
    file.slice(0, insertIndex) + insertion + file.slice(insertIndex);

  showDiff(file, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};

/**
 * Patch 4: Suppress the ChannelsNotice experimental / prompt-injection banner.
 *
 * Method 1 (CC >= 2.1.216 at least — jsx runtime + React-compiler memoized):
 * the banner is a jsxs children ARRAY with the server descriptor and the flag
 * as separate array elements, so the old single-string anchor cannot match:
 *   jsxs(h,{dimColor:!0,children:["Channels (experimental) messages from ",
 *     APe," inject directly in this session \xB7 restart without ",RPe,
 *     " to stop"]})
 * We rewrite only the two string literals and keep the array structure and
 * both interpolated identifiers. The middle dot is written as the literal
 * escape `\xB7` (backslash, x, B, 7) so no non-ASCII byte enters the bundle.
 *
 * Method 2 (older CC) — the original single concatenated string:
 *   "Experimental · inbound messages will be pushed into this session, this
 *    carries prompt injection risks. Restart Claude Code without {flag} to
 *    disable."
 *
 * We replace the warning text (up to the flag interpolation) with a short
 * neutral message. The middle dot (·, U+00B7) may appear as literal or
 * escaped (\xB7 / \u00B7) depending on the bundler.
 */
const patchChannelsNotice = (file: string): string | null => {
  // Method 1: jsx children-array shape. `[^"]*` spans " inject directly in
  // this session <dot> " regardless of how the bundler encodes the dot.
  const jsxPattern =
    /"Channels \(experimental\) messages from ",([$\w]+),"[^"]*restart without "/;
  const jsxMatch = file.match(jsxPattern);

  if (jsxMatch && jsxMatch.index !== undefined) {
    const replacement =
      `"Channels active \\xB7 messages from ",${jsxMatch[1]},` +
      '" \\xB7 restart without "';
    const startIndex = jsxMatch.index;
    const endIndex = startIndex + jsxMatch[0].length;

    const newFile =
      file.slice(0, startIndex) + replacement + file.slice(endIndex);

    showDiff(file, newFile, replacement, startIndex, endIndex);
    return newFile;
  }

  // Method 2 (older CC): a single concatenated warning string.
  const legacyPattern =
    /Experimental[^"]*?inbound messages will be pushed into this session, this carries prompt injection risks\. Restart Claude Code without /;
  const legacyMatch = file.match(legacyPattern);

  if (legacyMatch && legacyMatch.index !== undefined) {
    const replacement = 'Channels active. Restart Claude Code without ';
    const startIndex = legacyMatch.index;
    const endIndex = startIndex + legacyMatch[0].length;

    const newFile =
      file.slice(0, startIndex) + replacement + file.slice(endIndex);

    showDiff(file, newFile, replacement, startIndex, endIndex);
    return newFile;
  }

  console.error(
    'patch: channelsMode: failed to find ChannelsNotice warning text'
  );
  return null;
};

/**
 * Patch 5: Remove the "server: entries need --dangerously-load-development-
 * channels" cosmetic warning in ChannelsNotice.
 *
 * The component pre-validates entries and pushes an unmatched warning for
 * server-kind entries without entry.dev. This is purely display — the gate
 * is already patched — but shows a confusing line at startup.
 *
 * We remove the entire if(!entry.dev){push(...)} block. In minified code:
 *   if(!VAR.dev)VAR2.push({entry:VAR,why:"server: entries need ..."})
 *
 * Anchored on the unique "server: entries need" string to avoid false matches.
 */
const patchServerDevWarning = (file: string): string | null => {
  // Match the full if-block: if(!x.dev)y.push({...,"server: entries need ..."})
  // The push arg object ends with }) — we match through the closing paren.
  const pattern =
    /if\(![$\w]+\.dev\)[$\w]+\.push\(\{[$\w]+:[$\w]+,[$\w]+:"server: entries need --dangerously-load-development-channels"\}\)/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: channelsMode: failed to find server dev-flag warning block'
    );
    return null;
  }

  const replacement = '';
  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);
  return newFile;
};

/**
 * Combined patch — bypasses all channel gates and suppresses warnings:
 * 1. isChannelsEnabled() → true (tengu_harbor)
 * 2. gateChannelServer() → register after capability check
 * 3. isChannelPermissionRelayEnabled() → true (tengu_harbor_permissions)
 * 4. ChannelsNotice "Experimental" warning → neutral text
 * 5. ChannelsNotice server dev-flag warning → removed
 */
export const writeChannelsMode = (oldFile: string): string | null => {
  let newFile = patchChannelsEnabled(oldFile);
  if (!newFile) return null;

  newFile = patchChannelsDisabledProbe(newFile);

  newFile = patchGateFunction(newFile);
  if (!newFile) return null;

  newFile = patchPermissionRelay(newFile);
  if (!newFile) return null;

  // Steps 4 and 5 used to be best-effort (`?? newFile`), which meant a missed
  // anchor printed an error line and the patch still reported success — the
  // ChannelsNotice banner rewrite silently did nothing from CC 2.1.216 (jsx
  // children-array shape) until it was noticed at 2.1.220. Both anchors are
  // present in every CC build this patch supports, so a miss is real drift and
  // must fail loudly rather than half-apply.
  newFile = patchChannelsNotice(newFile);
  if (!newFile) return null;

  newFile = patchServerDevWarning(newFile);
  if (!newFile) return null;

  return newFile;
};
