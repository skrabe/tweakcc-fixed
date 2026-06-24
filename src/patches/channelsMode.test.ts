import { describe, it, expect, vi } from 'vitest';
import { writeChannelsMode } from './channelsMode';

// channels-mode force-enables MCP channel notifications by bypassing five
// gates/warnings. The fixture mirrors the five minified shapes the patch
// targets (see channelsMode.ts header comment):
//
//  1. isChannelsEnabled():    function qX_(){return A9("tengu_harbor",!1)}
//  2. gateChannelServer():    ...reason:"server did not declare claude/channel capability"};
//  3. permission relay:       function pQ7(){return A9("tengu_harbor_permissions",!1)}
//  4. ChannelsNotice banner:  "Experimental \xB7 inbound messages will be pushed...Restart Claude Code without "
//  5. server dev-flag warning: if(!E.dev)Q.push({entry:E,why:"server: entries need --dangerously-load-development-channels"})
const GATE_ENABLED = 'function qX_(){return A9("tengu_harbor",!1)}';
const GATE_RELAY = 'function pQ7(){return A9("tengu_harbor_permissions",!1)}';
const GATE_SERVER =
  '{ok:!1,reason:"server did not declare claude/channel capability"};if(!isChannelsEnabled())return{action:"skip"};';
const NOTICE_BANNER =
  '$Q1("Experimental \xB7 inbound messages will be pushed into this session, this carries prompt injection risks. Restart Claude Code without "+P9)';
const SERVER_DEV_WARNING =
  'if(!E.dev)Q.push({entry:E,why:"server: entries need --dangerously-load-development-channels"})';

const FIXTURE =
  `a=1;${GATE_ENABLED};b=2;${GATE_SERVER}c=3;${GATE_RELAY};` +
  `d=4;${NOTICE_BANNER};e=5;${SERVER_DEV_WARNING};f=6;`;

describe('writeChannelsMode', () => {
  it('applies all five channel-gate bypasses / warning suppressions', () => {
    const out = writeChannelsMode(FIXTURE);
    expect(out).not.toBeNull();

    // Patch 1: early `return !0;` injected into the tengu_harbor gate body,
    // before the original GrowthBook lookup.
    expect(out).toContain(
      'function qX_(){return !0;return A9("tengu_harbor",!1)}'
    );

    // Patch 2: register action injected right after the capability-check return.
    expect(out).toContain(
      'reason:"server did not declare claude/channel capability"};return{action:"register"};'
    );

    // Patch 3: early `return !0;` injected into the tengu_harbor_permissions gate.
    expect(out).toContain(
      'function pQ7(){return !0;return A9("tengu_harbor_permissions",!1)}'
    );

    // Patch 4: experimental/prompt-injection warning replaced with neutral text.
    expect(out).toContain('Channels active. Restart Claude Code without ');
    expect(out).not.toContain('prompt injection risks');

    // Patch 5: the server dev-flag warning push block is removed entirely.
    expect(out).not.toContain(
      'server: entries need --dangerously-load-development-channels'
    );
    // Its surrounding context survives (only the if-block was excised).
    expect(out).toContain('e=5;;f=6;');
  });

  it('tolerates an escaped \\xB7 middle dot in the banner', () => {
    // The bundler may emit the U+00B7 dot as a \xB7 escape rather than literally.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const escapedNotice = NOTICE_BANNER.replace('\xB7', '\\xB7');
    const input = `${GATE_ENABLED};${GATE_SERVER}${GATE_RELAY};${escapedNotice};`;
    const out = writeChannelsMode(input);
    errSpy.mockRestore();
    expect(out).not.toBeNull();
    expect(out).toContain('Channels active. Restart Claude Code without ');
    expect(out).not.toContain('prompt injection risks');
  });

  it('still succeeds when the optional notice/dev-flag warnings are absent', () => {
    // Patches 4 and 5 are best-effort (`?? newFile`); only the three gate
    // patches are required. A binary missing the cosmetic warnings must still
    // apply the three required gate bypasses.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = `${GATE_ENABLED};${GATE_SERVER}${GATE_RELAY};`;
    const out = writeChannelsMode(input);
    errSpy.mockRestore();

    expect(out).not.toBeNull();
    expect(out).toContain(
      'function qX_(){return !0;return A9("tengu_harbor",!1)}'
    );
    expect(out).toContain(
      'reason:"server did not declare claude/channel capability"};return{action:"register"};'
    );
    expect(out).toContain(
      'function pQ7(){return !0;return A9("tengu_harbor_permissions",!1)}'
    );
  });

  it('handles $-bearing minified identifiers in the gate functions', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input =
      'function $a$(){return $L9("tengu_harbor",!1)};' +
      '{reason:"server did not declare claude/channel capability"};' +
      'function $b$(){return $L9("tengu_harbor_permissions",!1)};';
    const out = writeChannelsMode(input);
    errSpy.mockRestore();
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

  it('returns null (without throwing) on a file with none of the shapes', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeChannelsMode('x=1;function y(){return 2}')).toBeNull();
    errSpy.mockRestore();
  });
});
