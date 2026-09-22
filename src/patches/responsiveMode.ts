// Please see the note about writing patches in ./index
//
// Unlock Claude Code's bundled "responsive-mode" plugin.
//
// CC 2.1.280 ships a built-in plugin called `responsive-mode` whose whole
// implementation is in the bundle: a `<responsive-mode>` system-reminder pushed
// on every composer-typed prompt, a `# Responsive mode` system-prompt section,
// and a PromptHint tweak. Nothing about it is fetched at runtime.
//
// It is nonetheless unreachable, because its availability predicate consults a
// server flag that currently answers false:
//
//   var l=()=>!1;                                   // the flag's fallback
//   var h=()=>yVe()&&Oa("tengu_quiet_ember",l());   // isAvailable
//   var d={name:"responsive-mode",description:"...",isAvailable:h};
//
// `Oa(name, fallback)` is the pinned dynamic-config reader and `yVe()` is a
// local session-kind check (false for bg/daemon sessions, true for an
// interactive TUI). So the ONLY thing withholding the feature is Anthropic's
// flag. We drop that term and keep `yVe()`, which is a real precondition.
//
// Availability is not the same as being on. `mde()` resolves each built-in
// plugin's enabled state as:
//
//   let p = settings.enabledPlugins?.[`${name}@${ver}`];
//   let i = p!==void 0 ? p===!0 : s.defaultEnabled ?? !0;
//
// The responsive-mode listing ships no `defaultEnabled`, so merely making it
// available would switch it ON for everyone. That is the wrong default for a
// feature Anthropic has not launched, and it is a behavioural change the user
// did not ask for, so we also splice `defaultEnabled:!1` into the listing. The
// result is a plugin that appears in `/plugin`, stays off until the user turns
// it on, and is then remembered in `enabledPlugins` like any other.
//
// Idempotent: the rewritten predicate no longer contains the flag name, so a
// re-apply finds nothing to do and returns the file unchanged.

import { showDiff } from './index';

export const writeResponsiveMode = (oldFile: string): string | null => {
  // The listing object carries the plugin name, so anchor on that and capture
  // the `isAvailable` binding it names rather than assuming a minified name.
  //   var d={name:"responsive-mode",description:"...",isAvailable:h};
  // The `defaultEnabled` alternative is what WE splice in below, so the pattern
  // has to tolerate it or a re-apply cannot find the listing it already edited.
  // Captures: 1=head through `description:`, 2=description value,
  //           3=tail from the first following prop, 4=isAvailable binding.
  const listingPattern =
    /(\{name:"responsive-mode",description:)("(?:[^"\\]|\\.)*")((?:,defaultEnabled:![01])?,isAvailable:([$\w]+)\})/;
  const listing = oldFile.match(listingPattern);
  if (!listing || listing.index === undefined) {
    if (!oldFile.includes('"responsive-mode"')) {
      console.log(
        'patch: responsiveMode: this CC build ships no responsive-mode plugin — no-op'
      );
      return oldFile;
    }
    console.error(
      'patch: responsiveMode: failed to find the responsive-mode plugin listing'
    );
    return null;
  }

  const availName = listing[4];

  // Already unlocked by an earlier apply: the predicate no longer reads the
  // flag and the listing already carries an explicit default.
  const escaped = availName.replace(/[$]/g, '\\$');
  const unlocked = new RegExp(`var ${escaped}=\\(\\)=>[$\\w]+\\(\\);`).test(
    oldFile
  );
  if (unlocked && listing[0].includes('defaultEnabled')) {
    return oldFile;
  }

  // The availability predicate. Keep the session-kind guard (group 2), drop the
  // dynamic-config consult entirely.
  //   var h=()=>yVe()&&Oa("tengu_quiet_ember",l());
  // Captures: 1=`var h=()=>`, 2=session-kind call, 3=the flag name.
  const availPattern = new RegExp(
    `(var ${escaped}=\\(\\)=>)([$\\w]+\\(\\))&&[$\\w]+\\("([a-z0-9_]+)",[$\\w]+\\(\\)\\);`
  );
  const avail = oldFile.match(availPattern);
  if (!avail || avail.index === undefined) {
    console.error(
      'patch: responsiveMode: failed to find the responsive-mode availability gate'
    );
    return null;
  }

  let newFile = oldFile;

  // 1. Neutralise the server gate, preserving the local session-kind check.
  const availReplacement = `${avail[1]}${avail[2]};`;
  newFile =
    newFile.slice(0, avail.index) +
    availReplacement +
    newFile.slice(avail.index + avail[0].length);
  showDiff(
    oldFile,
    newFile,
    availReplacement,
    avail.index,
    avail.index + avail[0].length
  );

  // 2. Default it OFF so unlocking does not silently turn it on. Re-match the
  //    listing against the rewritten file: splice 1 may have moved its offset.
  const listing2 = newFile.match(listingPattern);
  if (!listing2 || listing2.index === undefined) {
    console.error(
      'patch: responsiveMode: listing vanished after the gate rewrite'
    );
    return null;
  }
  if (!listing2[0].includes('defaultEnabled')) {
    const before = newFile;
    const listingReplacement = `${listing2[1]}${listing2[2]},defaultEnabled:!1${listing2[3]}`;
    newFile =
      newFile.slice(0, listing2.index) +
      listingReplacement +
      newFile.slice(listing2.index + listing2[0].length);
    showDiff(
      before,
      newFile,
      listingReplacement,
      listing2.index,
      listing2.index + listing2[0].length
    );
  }

  return newFile;
};
