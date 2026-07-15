import { describe, expect, it } from 'vitest';
import { writeAutoModeClassifierModel } from './autoModeClassifierModel';

const SHAPE_2_1_177 =
  'function Gr9(){let H=w7(),_=j_("tengu_auto_mode_config",{}),q=_?.modelByMainModel;' +
  'if(q){let K=HW(D9(H));if(_J(H)){let T=q[`${K}[1m]`];if(T)return T}let O=q[K];if(O)return O}' +
  'if(_?.model)return _.model;' +
  'if(KJ_(H)||OJ_(H))return iM_(H);' +
  'return H}';

const SHAPE_2_1_170 =
  'function Fr7(){let H=w7(),_=j_("tengu_auto_mode_config",{}),q=_?.modelByMainModel;' +
  'if(q){let K=W9(H).replace(/\\[1m\\]$/,"");if(_J(H)){let T=q[`${K}[1m]`];if(T)return T}let O=q[K];if(O)return O}' +
  'if(_?.model)return _.model;' +
  'if(KJ_(H)||OJ_(H)){let K=$_.ANTHROPIC_DEFAULT_OPUS_MODEL??jO().opus48;if((_J(H)||UE(H))&&!_J(K)&&!wP_(K))return K+"[1m]";return K}' +
  'return H}';

const SHAPE_2_1_167 =
  'function Sr1(){let H=w7(),_=j_("tengu_auto_mode_config",{}),q=_?.modelByMainModel;' +
  'if(q){let K=W9(H).replace(/\\[1m\\]$/,"");if(_J(H)){let T=q[`${K}[1m]`];if(T)return T}let O=q[K];if(O)return O}' +
  'if(_?.model)return _.model;return H}';

describe('writeAutoModeClassifierModel', () => {
  it('rewrites the 2.1.177 resolver (nested key-normalization + collapsed Fable branch)', () => {
    const file = `var A=1;${SHAPE_2_1_177}var B=2;`;
    const result = writeAutoModeClassifierModel(file, 'sonnet');
    expect(result).toContain('function Gr9(){return "claude-sonnet-4-6"}');
    expect(result).not.toContain('tengu_auto_mode_config');
    expect(result).toContain('var A=1;');
    expect(result).toContain('var B=2;');
  });

  it('rewrites the 2.1.170 resolver (with the Fable default-opus branch)', () => {
    const file = `var A=1;${SHAPE_2_1_170}var B=2;`;
    const result = writeAutoModeClassifierModel(file, 'sonnet');
    expect(result).toContain('function Fr7(){return "claude-sonnet-4-6"}');
    expect(result).not.toContain('tengu_auto_mode_config');
    expect(result).toContain('var A=1;');
    expect(result).toContain('var B=2;');
  });

  it('still rewrites the 2.1.167 resolver', () => {
    const file = `var A=1;${SHAPE_2_1_167}var B=2;`;
    const result = writeAutoModeClassifierModel(file, 'haiku');
    expect(result).toContain('function Sr1(){return "claude-haiku-4-5"}');
  });

  it('rewrites the 2.1.195 resolver (tagged {value,src} object returns)', () => {
    const SHAPE_2_1_195 =
      'function vol(){let e=Es(),t=at("tengu_auto_mode_config",{}),n=t?.modelByMainModel;' +
      'if(n){let r=_a(fo(e));if(S_(e)){let s=n[`${r}[1m]`];if(s)return{value:s,src:"gb"}}let o=n[r];if(o)return{value:o,src:"gb"}}' +
      'if(t?.model)return{value:t.model,src:"gb"};' +
      'if(nA(e)||BOt(e))return{value:UOt(e),src:"default"};' +
      'return{value:e,src:"default"}}';
    const file = `function col(){return vol().value}${SHAPE_2_1_195}var B=2;`;
    const result = writeAutoModeClassifierModel(file, 'haiku');
    expect(result).toContain(
      'function vol(){return{value:"claude-haiku-4-5",src:"default"}}'
    );
    expect(result).not.toContain('tengu_auto_mode_config');
    expect(result).toContain('function col(){return vol().value}');
    expect(result).toContain('var B=2;');
    // idempotent
    expect(writeAutoModeClassifierModel(result as string, 'haiku')).toBe(
      result
    );
  });

  it('rewrites the 2.1.201 resolver (modelByMainModel lookup extracted to a helper)', () => {
    const SHAPE_2_1_201 =
      'function MXa(){let e=Is(),t=nt("tengu_auto_mode_config",{}),n=NXa(t?.modelByMainModel);' +
      'if(n)return{value:n,src:"gb"};' +
      'if(t?.model)return{value:t.model,src:"gb"};' +
      'if(kA(e)||IFt(e))return{value:HFt(e),src:"default"};' +
      'return{value:e,src:"default"}}';
    const file = `function W(){return MXa().value}${SHAPE_2_1_201}var B=2;`;
    const result = writeAutoModeClassifierModel(file, 'haiku');
    expect(result).toContain(
      'function MXa(){return{value:"claude-haiku-4-5",src:"default"}}'
    );
    expect(result).not.toContain('tengu_auto_mode_config');
    expect(result).toContain('function W(){return MXa().value}');
    expect(result).toContain('var B=2;');
    // idempotent
    expect(writeAutoModeClassifierModel(result as string, 'haiku')).toBe(
      result
    );
  });

  it('rewrites the 2.1.210 resolver (demotion gate + external-default lookup)', () => {
    const SHAPE_2_1_210 =
      'function Fds(){let e=Hi(),t=Ze("tengu_auto_mode_config",{}),r=Red(t?.modelByMainModel);' +
      'if(r)return{value:r,src:"gb"};' +
      'if(t?.model)return{value:t.model,src:"gb"};' +
      'if(pdo!=="demoted"){let n=WTi(e);if(n)return{value:n,src:"default",externalDefault:!0}}' +
      'return{value:Nds(e),src:"default"}}';
    const file = `function Ids(){return Fds().value}${SHAPE_2_1_210}var B=2;`;
    const result = writeAutoModeClassifierModel(file, 'haiku');
    expect(result).toContain(
      'function Fds(){return{value:"claude-haiku-4-5",src:"default"}}'
    );
    expect(result).not.toContain('tengu_auto_mode_config');
    expect(result).toContain('function Ids(){return Fds().value}');
    expect(result).toContain('var B=2;');
    // idempotent
    expect(writeAutoModeClassifierModel(result as string, 'haiku')).toBe(
      result
    );
  });

  it('is a no-op for choice=default', () => {
    const file = `var A=1;${SHAPE_2_1_170}`;
    expect(writeAutoModeClassifierModel(file, 'default')).toBe(file);
  });

  it('skips an already-patched resolver instead of failing', () => {
    const patched = writeAutoModeClassifierModel(
      `var A=1;${SHAPE_2_1_170}`,
      'sonnet'
    );
    expect(patched).not.toBeNull();
    expect(writeAutoModeClassifierModel(patched as string, 'sonnet')).toBe(
      patched
    );
  });
});
