import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fffViewerSetup, writeFffBashReads } from './fffBashReads';
import { writeSwapRipgrepForFff } from './swapRipgrepForFff';
import { applyPatchImplementations } from './index';
import { writeFffInstructionHygiene } from './fffInstructions';

const commandFixture =
  ';function build(command){let $commands=[];$commands.push("snapshot");$commands.push("scrub");$commands.push(`eval ${command}`),$commands.push(`pwd -P >| ${quote(["cwd"] )}`);return $commands}';
const wrapper = '/tmp/rg-fff';
const searchFixture =
  'var glob="Glob";var grep="Grep";var empty=new Set;var hidden=new Set([glob,grep]);' +
  'function excluded(){if(!gate()||!bash())return empty;let names=hidden,aliases;return aliases??names}' +
  ';function snippets(){if(!gate())return null;return["unalias find 2>/dev/null || true","unalias grep 2>/dev/null || true",""]}' +
  ';function snapshot(){let commands=snippets();if(commands!==null){const marker="FIND_GREP_FUNC_END";return commands}return""}';
const instructionFixture =
  ';async function*fffQuery($input,$events,$commands,$runner){let{systemPrompt:$base,userContext:$user,systemContext:$environment,canUseTool:$permission}=$input;' +
  'let $current=$input.toolUseContext,$selected={systemPrompt:$base},$routing={systemContext:$environment},$rows=[],$source="fixture",$stamp={};' +
  'let $wire=$identity($merge($selected.systemPrompt,$routing.systemContext)),$unused,$other,$entries,$copies,$record=()=>{let $next=$extra($rows,$entries,{options:$current.options,querySource:$source,stamp:$stamp,toolInputCopies:$copies});return $next};yield $wire;}' +
  ';async function fffContext($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,mainThreadAgentDefinition:$agent}=$details;' +
  'let $saved=$details.snapshot,$fallback=$details.prompt,$tools={};let $counted=$saved?.systemPrompt??$fallback,$descriptions=$tools?.toolDescriptions,$schemas=$tools?.toolEntries;return $counted;}' +
  ';function fffRender($rows,$visible=[],$model,$config){$rows=$fold($rows,$config?.accountMemoryWithheld,$memo(()=>$visible));let $output=[];for(let $row of $rows){' +
  'let $options={},$active=false,$result=$config?.withoutAttachmentHooks?$live($row,$options):$recorded($row,$options,$active),$rendered=$result.messages,{isKnownType:$known,recordedRole:$role}=$result;$output.push(...$rendered)}return $output;}';
const fixtureFor = (binary: string): string => {
  const patched = writeSwapRipgrepForFff(
    searchFixture + instructionFixture + commandFixture,
    binary
  );
  if (patched === null) {
    throw new Error(
      'fffBashReads fixture requires the complete search integration'
    );
  }
  return patched;
};
const fixture = fixtureFor(wrapper);

describe('fffBashReads', () => {
  it('inserts setup after snapshot and scrubbing, immediately before evaluation', () => {
    const patched = writeFffBashReads(fixture, '/tmp/viewers', wrapper)!;
    const commands = new Function('quote', patched + ';return build("task")')(
      () => 'cwd'
    ) as string[];
    expect(commands.slice(0, 2)).toEqual(['snapshot', 'scrub']);
    expect(commands[2]).toContain('RG_FFF_CONTEXT_ROOT="$PWD"');
    expect(commands[3]).toBe('eval task');
    expect(commands[4]).toBe('pwd -P >| cwd');
    expect(writeFffBashReads(patched, '/tmp/viewers', wrapper)).toBe(patched);
  });

  it('keeps JS and shell syntax valid for difficult directory names', () => {
    const directory = "/tmp/José/'`x${HOME}/viewers";
    const trickyWrapper = directory + '/../rg-fff';
    const patched = writeFffBashReads(
      fixtureFor(trickyWrapper),
      directory,
      trickyWrapper
    )!;
    expect(patched).not.toContain('José');
    expect(patched).toContain('Jos\\u00e9');
    const commands = new Function('quote', patched + ';return build("task")')(
      () => 'cwd'
    ) as string[];
    expect(commands[2]).toBe(fffViewerSetup(directory, trickyWrapper));
    for (const shell of ['bash', 'zsh']) {
      const result = spawnSync(shell, ['-n', '-c', commands[2]]);
      if (!result.error) expect(result.status).toBe(0);
    }
  });

  it('refuses absent or ambiguous command anchors', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        writeFffBashReads('unrelated', '/tmp/viewers', wrapper)
      ).toBeNull();
      expect(
        writeFffBashReads(fixture + fixture, '/tmp/viewers', wrapper)
      ).toBeNull();
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  it('requires the actual shell integration for selective application and critical failures', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const implementations = {
        'no-global-cache-scope': {
          fn: (file: string) => file,
          condition: false,
        },
        'fff-instruction-hygiene': {
          fn: (file: string) => writeFffInstructionHygiene(file),
        },
        'swap-ripgrep-for-fff': {
          fn: (file: string) => writeSwapRipgrepForFff(file, wrapper),
          condition: true,
        },
        'fff-bash-reads': {
          fn: (file: string) =>
            writeFffBashReads(file, '/tmp/viewers', wrapper),
          condition: true,
        },
      } as unknown as Parameters<typeof applyPatchImplementations>[1];
      for (const filter of [
        ['fff-bash-reads'],
        ['swap-ripgrep-for-fff', 'fff-bash-reads'],
      ]) {
        const result = applyPatchImplementations(
          commandFixture,
          implementations,
          filter
        );
        expect(result.content).toBe(commandFixture);
        expect(
          result.results.find(item => item.id === 'fff-bash-reads')?.failed
        ).toBe(true);
      }
      const disabled = applyPatchImplementations(
        commandFixture,
        {
          ...implementations,
          'swap-ripgrep-for-fff': {
            ...implementations['swap-ripgrep-for-fff'],
            condition: false,
          },
          'fff-bash-reads': {
            ...implementations['fff-bash-reads'],
            condition: false,
          },
        },
        ['swap-ripgrep-for-fff', 'fff-bash-reads']
      );
      expect(disabled.content).toBe(commandFixture);
      expect(
        disabled.results.filter(item => item.id === 'fff-bash-reads')[0].skipped
      ).toBe(true);
      expect(
        writeFffBashReads(fixture, '/tmp/viewers', '/other-wrapper')
      ).toBeNull();
      const once = writeFffBashReads(fixture, '/tmp/viewers', wrapper)!;
      expect(writeFffBashReads(once, '/tmp/viewers', wrapper)).toBe(once);
      expect(error).toHaveBeenCalledWith(
        'patch: fffBashReads: managed fff shell integration is required'
      );
    } finally {
      error.mockRestore();
    }
  });

  it('captures initial scope and retains an empty PATH component', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fff-shell-setup-'));
    try {
      const viewers = path.join(root, 'viewers');
      const maskWrapper = path.join(root, 'rg-fff');
      await fs.writeFile(maskWrapper, '#!/bin/sh\nprintf 15\n', {
        mode: 0o700,
      });
      await fs.mkdir(path.join(viewers, '15'), { recursive: true });
      for (const reader of ['cat', 'head', 'tail', 'sed']) {
        await fs.writeFile(
          path.join(viewers, '15', reader),
          '#!/bin/sh\nexit 0\n',
          {
            mode: 0o700,
          }
        );
      }
      const command =
        fffViewerSetup(viewers, maskWrapper) +
        '; printf "%s\\n%s\\n" "$PATH" "$RG_FFF_CONTEXT_ROOT"';
      const result = spawnSync('/bin/bash', ['--norc', '-c', command], {
        cwd: root,
        env: { PATH: '' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout.split('\n')).toEqual([
        viewers + '/15:',
        await fs.realpath(root),
        '',
      ]);
      const missing = spawnSync('/bin/bash', [
        '-c',
        fffViewerSetup('/missing', wrapper),
      ]);
      expect(missing.status).toBe(0);
      for (const shell of ['/bin/bash', '/bin/zsh']) {
        const noRc = shell === '/bin/zsh' ? '-f' : '--norc';
        for (const variable of [
          'PATH',
          'RG_FFF_VIEWER_DIR',
          'RG_FFF_CONTEXT_ROOT',
        ]) {
          const guarded = spawnSync(
            shell,
            [
              noRc,
              '-c',
              `readonly ${variable}=original; ` +
                fffViewerSetup(viewers, maskWrapper) +
                ' && printf task',
            ],
            { cwd: root, encoding: 'utf8' }
          );
          if (!guarded.error) {
            expect(guarded.status).toBe(0);
            expect(guarded.stdout).toBe('task');
            expect(guarded.stderr).toBe('');
          }
        }
        const unset = spawnSync(
          shell,
          [
            noRc,
            '-c',
            'set -u; unset PATH; ' +
              fffViewerSetup(viewers, maskWrapper) +
              ' && printf task',
          ],
          { cwd: root, encoding: 'utf8' }
        );
        if (!unset.error) {
          expect(unset.status, shell + ': ' + unset.stderr).toBe(0);
          expect(unset.stdout).toBe('task');
          expect(unset.stderr).toBe('');
        }
      }
      for (const output of ['0', '99', 'invalid']) {
        await fs.writeFile(maskWrapper, `#!/bin/sh\nprintf '${output}'\n`);
        const skipped = spawnSync(
          '/bin/bash',
          ['-c', fffViewerSetup(viewers, maskWrapper) + ' && printf task'],
          { cwd: root, encoding: 'utf8' }
        );
        expect(skipped.status).toBe(0);
        expect(skipped.stdout).toBe('task');
        expect(skipped.stderr).toBe('');
      }
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
