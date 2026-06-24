import { describe, it, expect, vi } from 'vitest';
import { writeSuppressNativeInstallerWarning } from './suppressNativeInstallerWarning';

// The patch strips Anthropic's "npm -> native installer" nag strings out of
// cli.js. Each WARNING_PATTERN targets one literal English message CC emits.
// These fixtures mirror how those strings appear embedded in the minified
// bundle (inside double/single-quoted string literals).
const SWITCHED_MSG =
  'Claude Code has switched from npm to native installer. Run `claude install` or see https://docs.anthropic.com/en/docs/claude-code/getting-started for more options.';
const DIR_MSG =
  'installMethod is native, but directory /home/u/.local/share/claude';
const MISSING_CMD_MSG =
  'installMethod is native, but claude command is missing or invalid at /home/u/.local/bin/claude';
const PATH_MSG =
  'Native installation exists but ~/.local/bin is not in your PATH. Run: echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc then open a new terminal or run: source ~/.bashrc';

describe('writeSuppressNativeInstallerWarning', () => {
  it('removes the npm->native "switched" nag string', () => {
    const input = `x=1;var Q="${SWITCHED_MSG}";y=2;`;
    const out = writeSuppressNativeInstallerWarning(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('switched from npm to native installer');
    // surrounding code is preserved; only the message body is blanked out
    expect(out).toBe('x=1;var Q="";y=2;');
  });

  it('removes the "installMethod is native, but directory" warning', () => {
    const input = `a=1;let M=\`${DIR_MSG}\`;b=2;`;
    const out = writeSuppressNativeInstallerWarning(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('installMethod is native, but directory');
    expect(out).toBe('a=1;let M=``;b=2;');
  });

  it('removes the "claude command is missing or invalid at" warning', () => {
    const input = `z="${MISSING_CMD_MSG}";`;
    const out = writeSuppressNativeInstallerWarning(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('claude command is missing or invalid');
    expect(out).toBe('z="";');
  });

  it('removes the "~/.local/bin is not in your PATH" warning (with PATH guidance)', () => {
    const input = `w='${PATH_MSG}';`;
    const out = writeSuppressNativeInstallerWarning(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('not in your PATH');
    expect(out).not.toContain('open a new terminal or run');
    expect(out).toBe("w='';");
  });

  it('strips multiple distinct warnings in a single pass', () => {
    const input = `q="${SWITCHED_MSG}";r="${MISSING_CMD_MSG}";s=3;`;
    const out = writeSuppressNativeInstallerWarning(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('switched from npm to native installer');
    expect(out).not.toContain('claude command is missing or invalid');
    expect(out).toBe('q="";r="";s=3;');
  });

  it('is idempotent — re-running on already-stripped output finds nothing (warns, returns null)', () => {
    const input = `x=1;var Q="${SWITCHED_MSG}";y=2;`;
    const first = writeSuppressNativeInstallerWarning(input)!;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = writeSuppressNativeInstallerWarning(first);
    warnSpy.mockRestore();

    expect(second).toBeNull();
  });

  it('returns null (without throwing) when no warning string is present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      writeSuppressNativeInstallerWarning('function unrelated(){return 1}')
    ).toBeNull();
    warnSpy.mockRestore();
  });
});
