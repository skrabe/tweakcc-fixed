import { describe, it, expect, vi } from 'vitest';
import { writeChannelsMode } from './channelsMode';

// channels-mode force-enables MCP channel notifications by bypassing five
// gates/warnings. The fixture mirrors the five minified shapes the patch
// targets (see channelsMode.ts header comment):
//
//  1. isChannelsEnabled():    function qX_(){return A9("tengu_harbor",!1)}
//  2. gateChannelServer():    ...reason:"server did not declare claude/channel capability"};
//  3. permission relay:       function pQ7(){return A9("tengu_harbor_permissions",!1)}
//  4. ChannelsNotice banner:  jsx children-array (current) or concatenated string (legacy)
//  5. server dev-flag warning: if(!E.dev)Q.push({entry:E,why:"server: entries need --dangerously-load-development-channels"})
const GATE_ENABLED = 'function qX_(){return A9("tengu_harbor",!1)}';
// CC >= 2.1.291: the gate also requires the allow_channels route, and a
// separate probe returns true (= "disabled") while tengu_harbor is off.
const GATE_ENABLED_291 =
  'function aL(){return nn("allow_channels")&&k("tengu_harbor",!1)}';
const DISABLED_PROBE_291 =
  'function bdt(){if(!k("tengu_harbor",!1))return!0;let e=Nf("allow_channels");return e!==null}';
const GATE_RELAY = 'function pQ7(){return A9("tengu_harbor_permissions",!1)}';
const GATE_SERVER =
  '{ok:!1,reason:"server did not declare claude/channel capability"};if(!isChannelsEnabled())return{action:"skip"};';

// Current shape (CC >= 2.1.216): jsx runtime + React-compiler memoization,
// children is an ARRAY and the two interpolations are separate elements.
// Verbatim from /tmp/cli-2.1.220.js, identifiers preserved.
const NOTICE_JSX =
  'T8=y0.jsxs(h,{dimColor:!0,children:["Channels (experimental) messages from ' +
  '",APe," inject directly in this session \\xB7 restart without ",RPe," to stop"]})';

// Legacy shape (older CC): one concatenated string ending at the flag.
const NOTICE_LEGACY =
  '$Q1("Experimental \xB7 inbound messages will be pushed into this session, this carries prompt injection risks. Restart Claude Code without "+P9)';

const SERVER_DEV_WARNING =
  'if(!E.dev)Q.push({entry:E,why:"server: entries need --dangerously-load-development-channels"})';

const fixture = (notice: string) =>
  `a=1;${GATE_ENABLED};b=2;${GATE_SERVER}c=3;${GATE_RELAY};` +
  `d=4;${notice};e=5;${SERVER_DEV_WARNING};f=6;`;

const FIXTURE = fixture(NOTICE_JSX);

// The three required gate bypasses, asserted the same way everywhere.
const expectGatesPatched = (out: string | null) => {
  expect(out).toContain(
    'function qX_(){return !0;return A9("tengu_harbor",!1)}'
  );
  expect(out).toContain(
    'reason:"server did not declare claude/channel capability"};return{action:"register"};'
  );
  expect(out).toContain(
    'function pQ7(){return !0;return A9("tengu_harbor_permissions",!1)}'
  );
};

describe('writeChannelsMode', () => {
  it('applies all five channel-gate bypasses / warning suppressions', () => {
    const out = writeChannelsMode(FIXTURE);
    expect(out).not.toBeNull();

    // Patches 1-3: the gate bypasses.
    expectGatesPatched(out);

    // Patch 4: the banner is actually rewritten in place — the whole jsxs
    // element, with the array structure and BOTH interpolated identifiers
    // (APe, RPe) preserved in order.
    expect(out).toContain(
      'T8=y0.jsxs(h,{dimColor:!0,children:["Channels active \\xB7 messages from ' +
        '",APe," \\xB7 restart without ",RPe," to stop"]})'
    );
    // ...and the experimental / prompt-injection framing is gone.
    expect(out).not.toContain('Channels (experimental)');
    expect(out).not.toContain('inject directly in this session');

    // No literal U+00B7 byte is injected — the dot is the escape `\xB7`.
    expect(out).not.toContain('\xB7');

    // Patch 5: the server dev-flag warning push block is removed entirely.
    expect(out).not.toContain(
      'server: entries need --dangerously-load-development-channels'
    );
    // Its surrounding context survives (only the if-block was excised).
    expect(out).toContain('e=5;;f=6;');
  });

  it('patches the CC 2.1.291 allow_channels gate and disabled probe', () => {
    const input =
      `a=1;function JGn(){let e=k("tengu_harbor_ledger",[]);return e}` +
      `${GATE_ENABLED_291}${DISABLED_PROBE_291};b=2;${GATE_SERVER}c=3;` +
      `${GATE_RELAY};d=4;${NOTICE_JSX};e=5;${SERVER_DEV_WARNING};f=6;`;
    const out = writeChannelsMode(input);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function aL(){return !0;return nn("allow_channels")&&k("tengu_harbor",!1)}'
    );
    expect(out).toContain(
      'function bdt(){return !1;if(!k("tengu_harbor",!1))return!0;'
    );
    expect(out).toContain('k("tengu_harbor_ledger",[])');
    expect(out).toContain(
      'reason:"server did not declare claude/channel capability"};return{action:"register"};'
    );
  });

  it('leaves older builds without the disabled probe untouched there', () => {
    const out = writeChannelsMode(FIXTURE);
    expect(out).not.toContain('return !1;');
  });

  it('rewrites the banner without $-substitution damage to identifiers', () => {
    // `$Rg`/`$&`-style sequences are real minified names; a String.replace
    // based splice would eat them as replacement patterns.
    const notice =
      'x=q.jsxs(h,{dimColor:!0,children:["Channels (experimental) messages from ' +
      '",$Rg," inject directly in this session \\xB7 restart without ",$$b," to stop"]})';
    const out = writeChannelsMode(fixture(notice));
    expect(out).not.toBeNull();
    expect(out).toContain(
      '["Channels active \\xB7 messages from ",$Rg," \\xB7 restart without ",$$b," to stop"]'
    );
  });

  it('tolerates a literal middle dot in the current banner shape', () => {
    // The bundler may emit U+00B7 literally rather than as a \xB7 escape.
    const notice = NOTICE_JSX.replace('\\xB7', '\xB7');
    const out = writeChannelsMode(fixture(notice));
    expect(out).not.toBeNull();
    expect(out).toContain(
      '["Channels active \\xB7 messages from ",APe," \\xB7 restart without ",RPe," to stop"]'
    );
    expect(out).not.toContain('inject directly in this session');
  });

  it('falls back to the legacy concatenated-string banner shape', () => {
    const out = writeChannelsMode(fixture(NOTICE_LEGACY));
    expect(out).not.toBeNull();
    expectGatesPatched(out);
    expect(out).toContain('Channels active. Restart Claude Code without ');
    expect(out).not.toContain('prompt injection risks');
  });

  it('tolerates an escaped \\xB7 middle dot in the legacy banner', () => {
    const notice = NOTICE_LEGACY.replace('\xB7', '\\xB7');
    const out = writeChannelsMode(fixture(notice));
    expect(out).not.toBeNull();
    expect(out).toContain('Channels active. Restart Claude Code without ');
    expect(out).not.toContain('prompt injection risks');
  });

  it('handles $-bearing minified identifiers in the gate functions', () => {
    const input =
      'function $a$(){return $L9("tengu_harbor",!1)};' +
      '{reason:"server did not declare claude/channel capability"};' +
      'function $b$(){return $L9("tengu_harbor_permissions",!1)};' +
      `${NOTICE_JSX};${SERVER_DEV_WARNING};`;
    const out = writeChannelsMode(input);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function $a$(){return !0;return $L9("tengu_harbor",!1)}'
    );
    expect(out).toContain(
      'function $b$(){return !0;return $L9("tengu_harbor_permissions",!1)}'
    );
  });

  it('returns null when the tengu_harbor gate (patch 1) is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Has the gate-function/relay/server shapes but NOT the tengu_harbor gate.
    const input = `${GATE_SERVER}${GATE_RELAY};`;
    expect(writeChannelsMode(input)).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the gateChannelServer capability check (patch 2) is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = `${GATE_ENABLED};${GATE_RELAY};`;
    expect(writeChannelsMode(input)).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the permission-relay gate (patch 3) is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = `${GATE_ENABLED};${GATE_SERVER}`;
    expect(writeChannelsMode(input)).toBeNull();
    errSpy.mockRestore();
  });

  // Regression guard for the silent-partial-failure class: patches 4 and 5
  // used to be best-effort, so a missed anchor printed an error line and the
  // patch still returned a non-null string. Asserting non-null is exactly the
  // check that could not see it — assert null, and assert the error is logged.
  it('returns null (not a half-applied string) when the banner is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = `${GATE_ENABLED};${GATE_SERVER}${GATE_RELAY};${SERVER_DEV_WARNING};`;
    expect(writeChannelsMode(input)).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      'patch: channelsMode: failed to find ChannelsNotice warning text'
    );
    errSpy.mockRestore();
  });

  it('returns null when the server dev-flag warning block is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = `${GATE_ENABLED};${GATE_SERVER}${GATE_RELAY};${NOTICE_JSX};`;
    expect(writeChannelsMode(input)).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      'patch: channelsMode: failed to find server dev-flag warning block'
    );
    errSpy.mockRestore();
  });

  it('returns null (without throwing) on a file with none of the shapes', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeChannelsMode('x=1;function y(){return 2}')).toBeNull();
    errSpy.mockRestore();
  });
});
