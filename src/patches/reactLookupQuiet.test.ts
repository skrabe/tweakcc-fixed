import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReactVarCache, getReactVar } from './helpers';
import {
  writeSlashCommandDefinition,
  writeToolsetComponentDefinition,
} from './toolsets';
import type { Toolset } from '../types';

// A code-split native bundle has no module loader or React module at the top
// of the file, so the global React lookup finds nothing. That is the normal
// state on every current Claude Code build, not a patch failure.
const SPLIT_BUNDLE =
  '#!/usr/bin/env node\n// @bun @bytecode\nvar __ccVirtualBundleModules = 2;\n' +
  '/*@@TWEAKCC_MODULE:0:/$bunfs/root/chunk-a.js@@*/\nfunction a(){return 1}\n' +
  '/*@@TWEAKCC_MODULE:1:/$bunfs/root/chunk-b.js@@*/\nfunction b(){return 2}\n';

// The pre-split shape getReactVar was written for.
const SINGLE_BUNDLE =
  'var T=(H,$,A)=>{A=H!=null?1:0};' +
  'var n7L=N((e)=>{var s=Symbol.for("react.element")});' +
  'var fH=N((AtM,r7L)=>{r7L.exports=n7L()});' +
  'var Rt=T(fH(),1);';

const TS: Toolset[] = [{ name: 'readonly', allowedTools: ['Read'] }];

describe('React lookup on a code-split bundle', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearReactVarCache();
    delete process.env.DEBUG;
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearReactVarCache();
  });

  it('returns undefined without printing', () => {
    expect(getReactVar(SPLIT_BUNDLE)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('still resolves React on a single-module bundle', () => {
    expect(getReactVar(SINGLE_BUNDLE)).toBe('Rt');
    expect(log).not.toHaveBeenCalled();
  });

  describe('the /toolset command', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
    const table =
      'var h={name:"help",description:"Show help"};' +
      `function tbl(){return[${ids}]}`;

    it('stays a text command when React exists but no component was inserted', () => {
      const out = writeSlashCommandDefinition(
        SINGLE_BUNDLE + table,
        TS,
        'readonly',
        null,
        null,
        false
      );
      expect(out).not.toBeNull();
      expect(out).toContain('type: "local",');
      expect(out).not.toContain('toolsetComp');
    });

    it('uses the JSX picker when the component was inserted', () => {
      const out = writeSlashCommandDefinition(
        SINGLE_BUNDLE + table,
        TS,
        'readonly'
      );
      expect(out).toContain('type: "local-jsx",');
      expect(out).toContain('Rt.createElement(toolsetComp');
    });
  });

  it('the toolset picker step skips quietly on a code-split bundle', () => {
    expect(
      writeToolsetComponentDefinition(SPLIT_BUNDLE, TS, 'readonly')
    ).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
