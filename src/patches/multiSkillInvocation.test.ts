import { describe, expect, it, vi } from 'vitest';

import { writeMultiSkillInvocation } from './multiSkillInvocation';

// The patch CAPTURES the executor (bcl@2.1.195, Nml@2.1.196) and cleanup from
// the dispatch seam, and DISCOVERS the command resolver and is-enabled helper by
// shape, so fixtures must include those helper definitions for discovery to
// succeed. `vcc` is the resolver's name/alias matcher.
const RESOLVER = 'function mE(e,t){return t.find((n)=>vcc(n,e))}';
const IS_ENABLED = 'function HH(e){return e.isEnabled?.()??!0}';
const SEAM_ONLY =
  'case"prompt":{let p=await bcl(c,t,r,o,s,l,d.hookMessages);return ke(u),p}catch(d){throw d}';
const SEAM = `${RESOLVER}${IS_ENABLED}${SEAM_ONLY}`;

describe('multiSkillInvocation', () => {
  it('splices a sibling-dispatch pass after the leading executor call', () => {
    const result = writeMultiSkillInvocation(SEAM);
    expect(result).not.toBeNull();
    // Leading call + return preserved verbatim.
    expect(result).toContain('let p=await bcl(c,t,r,o,s,l,d.hookMessages);');
    expect(result).toContain('return ke(u),p}catch(d){throw d}');
    // Sibling pass: parse args (t) for /tokens, resolve via the discovered
    // resolver against the ctx registry, re-invoke the executor, concatenate
    // messages — all guarded by try/catch.
    expect(result).toContain('try{let __tcMsiTok=');
    expect(result).toContain('__tcMsiRe.exec(t)');
    expect(result).toContain('mE(__tcMsiN,r.options.commands)');
    expect(result).toContain(
      'await bcl(__tcMsiC,__tcMsiA,r,[],[],globalThis.crypto.randomUUID(),[])'
    );
    // .slice(1) drops the sibling's command-message box, keeping body + perms.
    expect(result).toContain(
      'p={...p,messages:[...p.messages,...__tcMsiR.messages.slice(1)]}'
    );
    expect(result).toContain('}catch(__tcMsiE){}');
    // Only user-invocable, enabled, prompt-type siblings are dispatched.
    expect(result).toContain('__tcMsiC.type!=="prompt"');
    expect(result).toContain('__tcMsiC.userInvocable===!1');
    expect(result).toContain('!HH(__tcMsiC)');
  });

  it('captures the renamed executor and discovers renamed helpers (2.1.196 shape)', () => {
    // executor bcl→Nml, cleanup ke→He, resolver mE→OT, is-enabled HH→rk.
    const renamed =
      'function OT(e,t){return t.find((n)=>vcc(n,e))}' +
      'function rk(e){return e.isEnabled?.()??!0}' +
      'let p=await Nml(c,t,r,o,s,l,d.hookMessages);return He(u),p}';
    const result = writeMultiSkillInvocation(renamed);
    expect(result).not.toBeNull();
    expect(result).toContain('let p=await Nml(c,t,r,o,s,l,d.hookMessages);');
    expect(result).toContain('OT(__tcMsiN,r.options.commands)');
    expect(result).toContain('!rk(__tcMsiC)');
    expect(result).toContain(
      'await Nml(__tcMsiC,__tcMsiA,r,[],[],globalThis.crypto.randomUUID(),[])'
    );
    expect(result).toContain('return He(u),p}');
  });

  it('preserves minifier-renamed seam identifiers', () => {
    // result→$p, command→$c, args→$a, ctx→$x, cleanup→$k, telemetry→$u
    const renamed =
      `${RESOLVER}${IS_ENABLED}` +
      'let $p=await bcl($c,$a,$x,$o,$s,$l,$d.hookMessages);return $k($u),$p}';
    const result = writeMultiSkillInvocation(renamed);
    expect(result).not.toBeNull();
    expect(result).toContain(
      'let $p=await bcl($c,$a,$x,$o,$s,$l,$d.hookMessages);'
    );
    expect(result).toContain('__tcMsiRe.exec($a)');
    expect(result).toContain('mE(__tcMsiN,$x.options.commands)');
    expect(result).toContain(
      'await bcl(__tcMsiC,__tcMsiA,$x,[],[],globalThis.crypto.randomUUID(),[])'
    );
    expect(result).toContain(
      '$p={...$p,messages:[...$p.messages,...__tcMsiR.messages.slice(1)]}'
    );
    expect(result).toContain('return $k($u),$p}');
  });

  it('is a no-op when already patched (idempotent)', () => {
    const once = writeMultiSkillInvocation(SEAM);
    expect(once).not.toBeNull();
    expect(writeMultiSkillInvocation(once as string)).toBe(once);
  });

  it('returns null when the dispatch seam is absent', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      expect(writeMultiSkillInvocation('const x=1;')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        'patch: multiSkillInvocation: failed to find the leading-skill dispatch (executor call site)'
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns null when the resolver / is-enabled helpers cannot be discovered', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      // Seam present but no resolver/is-enabled defs to discover.
      expect(writeMultiSkillInvocation(SEAM_ONLY)).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        'patch: multiSkillInvocation: failed to discover the command resolver / is-enabled helper'
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
