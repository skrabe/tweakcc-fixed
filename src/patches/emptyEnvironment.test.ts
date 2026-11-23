import { describe, expect, it, vi } from 'vitest';
import {
  suppressEmptyEnvironment,
  writeEmptyEnvironment,
} from './emptyEnvironment';

const COMPOSER =
  'function $environment($local,$surface,$fast){let $parts=[$local,$surface,$fast].filter(($part)=>$part!==null);return[$heading,...$bullets($parts)].join(`\n`)}';
const RUNTIME =
  'function $runtime($data){return[$heading,$preamble,$data].join(`\n`)}';
const PRISTINE =
  'var $heading="# Environment",$preamble="You have been invoked in the following environment: ";' +
  COMPOSER +
  RUNTIME;
const evaluate = (source: string) =>
  new Function('$bullets', source + ';return{$environment,$runtime};')(
    (parts: string[]) => parts.map(part => ' - ' + part)
  ) as {
    $environment: (...parts: (string | null)[]) => string;
    $runtime: (data: string) => string;
  };

describe('empty environment composer', () => {
  it.each([
    ['', '', ''],
    [' ', '\n', '\t'],
    ['', null, ''],
    [null, null, null],
  ])('suppresses only an entirely blank scaffold: %j', (...parts) => {
    const patched = writeEmptyEnvironment(PRISTINE)!;
    expect(patched).not.toBeNull();
    expect(evaluate(patched).$environment(...parts)).toBe('');
    expect(writeEmptyEnvironment(patched)).toBe(patched);
  });

  it.each([
    ['Local machine; changes land in the working copy.', '', ''],
    ['', 'Remote sandbox; export work via git.', ''],
    ['', '', 'Fast mode information.'],
    [' ', 'Custom environment instructions.\nKeep this data.', ''],
  ])(
    'preserves every byte when any prose fragment is nonempty: %j',
    (...parts) => {
      const patched = evaluate(writeEmptyEnvironment(PRISTINE)!);
      expect(patched.$environment(...parts)).toBe(
        evaluate(PRISTINE).$environment(...parts)
      );
    }
  );

  it('leaves the runtime environment renderer and data unchanged', () => {
    const patched = writeEmptyEnvironment(PRISTINE)!;
    expect(patched).toContain(RUNTIME);
    const data =
      'Primary working directory: /work\nPlatform: linux\nShell: bash\nGitHub session proxy: configured';
    expect(evaluate(patched).$runtime(data)).toBe(
      evaluate(PRISTINE).$runtime(data)
    );
    expect(suppressEmptyEnvironment([42], '# Environment\n - 42')).toBe(
      '# Environment\n - 42'
    );
  });

  it.each([
    PRISTINE.replace(COMPOSER, ''),
    PRISTINE + COMPOSER,
    PRISTINE.replace('"# Environment"', '"# Custom"'),
  ])('rejects absent, ambiguous, or unrelated composers', source => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(writeEmptyEnvironment(source)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        'patch: emptyEnvironment: failed to find unique environment composer'
      );
    } finally {
      error.mockRestore();
    }
  });
});
