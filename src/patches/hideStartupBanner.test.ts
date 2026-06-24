import { describe, it, expect, vi } from 'vitest';
import { writeHideStartupBanner } from './hideStartupBanner';

// hideStartupBanner removes the "Welcome to Claude Code" startup card. The patch
// has four match methods (newest-first within the fn, but the legacy createElement
// shape is tried first). Each fixture below mirrors exactly one method's target
// minified shape.

// Method 1 — CC <2.1.83: the banner rendered as a createElement call with the
// {isBeforeFirstMessage:!1} prop. The whole call (between its surrounding commas)
// is collapsed to a single bare comma.
const LEGACY_FIXTURE =
  'a.createElement(b,null),$.createElement(K0,{isBeforeFirstMessage:!1}),c.createElement(d,null)';

// Method 2 — CC >=2.1.156: the startup card is a zero-arg component whose body
// opens with `let X=Y.c(N),Z=W().oauthAccount?.displayName??""`. `return null;`
// is injected at the very top of the body.
const MODERN_CARD_FIXTURE =
  'q=1;function H9(){let u=z8.c(3),k=Bq().oauthAccount?.displayName??"";return u}z=2;';

// Method 2b — the second modernCardPattern alternation (no `.c(N)` prefix).
const MODERN_CARD_FIXTURE_B =
  'q=1;function H9(){let u=z8(),k=Bq?.displayName??"";return u}z=2;';

// Method 3 — CC >=2.1.83: standalone zero-arg banner component containing both
// "Apple_Terminal" (theme branch, within 500 chars of the body) and
// "Welcome to Claude Code" (within the body). `return null;` injected at body top.
const STANDALONE_FIXTURE =
  'x=1;function Yb(){let t=T==="Apple_Terminal"?1:2;return q.createElement(W,null,"Welcome to Claude Code")}y=2;';

describe('writeHideStartupBanner', () => {
  it('collapses the legacy createElement banner to a bare comma (CC <2.1.83)', () => {
    const out = writeHideStartupBanner(LEGACY_FIXTURE);
    expect(out).not.toBeNull();
    // the whole createElement(..,{isBeforeFirstMessage:!1}).. call is gone
    expect(out).not.toContain('isBeforeFirstMessage');
    // the surrounding siblings collapse onto a single joining comma
    expect(out).toBe('a.createElement(b,null),c.createElement(d,null)');
  });

  it('injects `return null;` into the modern startup-card component (CC >=2.1.156)', () => {
    const out = writeHideStartupBanner(MODERN_CARD_FIXTURE);
    expect(out).not.toBeNull();
    expect(out).toContain('function H9(){return null;let u=z8.c(3)');
  });

  it('handles the second modern-card alternation (no .c(N) prefix)', () => {
    const out = writeHideStartupBanner(MODERN_CARD_FIXTURE_B);
    expect(out).not.toBeNull();
    expect(out).toContain('function H9(){return null;let u=z8()');
  });

  it('injects `return null;` into the standalone banner component (CC >=2.1.83)', () => {
    const out = writeHideStartupBanner(STANDALONE_FIXTURE);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'function Yb(){return null;let t=T==="Apple_Terminal"'
    );
    // original body still present after the early return
    expect(out).toContain('Welcome to Claude Code');
  });

  it('does NOT match a zero-arg fn with Apple_Terminal but no welcome string', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // has Apple_Terminal but lacks "Welcome to Claude Code" -> method 3 skips it
    const noWelcome = 'function Zz(){let t=T==="Apple_Terminal"?1:2;return t}';
    expect(writeHideStartupBanner(noWelcome)).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null (logging) when no banner shape is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeHideStartupBanner('function unrelated(){return 1}')).toBeNull();
    errSpy.mockRestore();
  });
});
