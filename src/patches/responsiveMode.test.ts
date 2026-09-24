import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeResponsiveMode } from './responsiveMode';

// Excerpt from the pristine darwin CC 2.1.280 responsive-mode plugin module
// (chunk-g13219m3.js): the availability predicate, its flag fallback, and the
// listing object, in the order the bundle emits them.
const PLUGIN =
  'var l=()=>!1;var h=()=>yVe()&&Oa("tengu_quiet_ember",l());' +
  'var d={name:"responsive-mode",description:"Responsive mode: Claude replies to you in a sentence before thinking or using tools, on every prompt",isAvailable:h};' +
  'var R=()=>jC({...d,hooksModule:VV(import.meta.dir,i,()=>w())});';

const cli = `var zz=1;${PLUGIN}var yy=2;`;

describe('writeResponsiveMode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('drops the server flag but keeps the session-kind guard', () => {
    const out = writeResponsiveMode(cli)!;
    expect(out).toContain('var h=()=>yVe();');
    // The flag is the only thing removed.
    expect(out).not.toContain('tengu_quiet_ember');
    expect(out).toContain('var l=()=>!1;');
  });

  it('registers the plugin disabled so unlocking does not turn it on', () => {
    const out = writeResponsiveMode(cli)!;
    expect(out).toContain('on every prompt",defaultEnabled:!1,isAvailable:h}');
  });

  it('leaves the rest of the bundle untouched', () => {
    const out = writeResponsiveMode(cli)!;
    expect(out.startsWith('var zz=1;')).toBe(true);
    expect(out.endsWith('var yy=2;')).toBe(true);
    expect(out).toContain('var R=()=>jC({...d,hooksModule:');
  });

  it('is idempotent — a re-apply changes nothing', () => {
    const once = writeResponsiveMode(cli)!;
    expect(writeResponsiveMode(once)).toBe(once);
  });

  it('no-ops on a build that ships no responsive-mode plugin', () => {
    const other = 'var a=1;var b=()=>!0;';
    expect(writeResponsiveMode(other)).toBe(other);
  });

  describe('CC 2.1.281 shape (extra negated local guard)', () => {
    // Pristine darwin 2.1.281: a `!tcn()` remote/Teams-entrypoint guard now
    // sits between the session-kind check and the flag consult.
    const cli281 = cli
      .replace(
        'var h=()=>yVe()&&Oa("tengu_quiet_ember",l());',
        'var h=()=>nKe()&&!tcn()&&na("tengu_quiet_ember",l());'
      )
      .replace('jC({...d,hooksModule:VV(', 'EA({...d,hooksModule:Rq(');

    it('drops the flag and keeps both local guards', () => {
      const out = writeResponsiveMode(cli281)!;
      expect(out).toContain('var h=()=>nKe()&&!tcn();');
      expect(out).not.toContain('tengu_quiet_ember');
      expect(out).toContain(
        'on every prompt",defaultEnabled:!1,isAvailable:h}'
      );
    });

    it('is idempotent', () => {
      const once = writeResponsiveMode(cli281)!;
      expect(writeResponsiveMode(once)).toBe(once);
    });
  });

  it('fails loudly when the plugin is present but the gate drifted', () => {
    // Listing intact, availability predicate reshaped into something else.
    const drifted = cli.replace(
      'var h=()=>yVe()&&Oa("tengu_quiet_ember",l());',
      'var h=()=>yVe()&&Oa("tengu_quiet_ember",l(),extraArg);'
    );
    expect(writeResponsiveMode(drifted)).toBeNull();
  });

  it('fails loudly when the listing drifted', () => {
    const drifted = cli.replace(
      'name:"responsive-mode",description:',
      'name:"responsive-mode",summary:'
    );
    expect(writeResponsiveMode(drifted)).toBeNull();
  });
});
