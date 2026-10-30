import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hasFffShellIntegration,
  restoreNativeSearchTools,
  writeSwapRipgrepForFff,
} from './swapRipgrepForFff';
import { FFF_PROJECT_GUIDANCE } from './fffInstructions';

const WRAPPER = '/Users/x/.tweakcc/fff/aarch64-apple-darwin/rg-fff';
const VISIBILITY =
  'var $glob="Glob";var $grep="Grep";' +
  'var $empty=new Set;var $excluded=new Set([$glob,$grep]);' +
  'function hidden(){if(!searchGate()||!hasBash())return $empty;' +
  'let $names=$excluded,$aliases;for(let name of $names){let alias=aliasFor(name);' +
  'if(alias!==void 0)$aliases??=new Set($names),$aliases.add(alias.name)}return $aliases??$names}';

const SHADOW =
  'function shadow($name,$tool,$arguments){return`function ${$name} {\n' +
  '  local _cc_bin="\\${CLAUDE_CODE_EXECPATH:-}"\n' +
  '  [[ -x $_cc_bin ]] || _cc_bin=/Users/x/.local/bin/claude\n' +
  '  if [[ ! -x $_cc_bin ]]; then command ${$name} "$@"; return; fi\n' +
  '  if [[ -n "\\${ZSH_VERSION:-}" ]]; then\n' +
  '    ARGV0=${$tool} "$_cc_bin" ${$arguments}\n' +
  '  elif [[ "$OSTYPE" == "msys" ]]; then\n' +
  '    ARGV0=${$tool} "$_cc_bin" ${$arguments}\n' +
  '  else\n' +
  '    (exec -a ${$tool} "$_cc_bin" ${$arguments})\n' +
  '  fi\n}`;}';
const SETUP =
  ';function snippets(){if(!searchGate())return null;return["unalias find 2>/dev/null || true","unalias grep 2>/dev/null || true",shadow("find","bfs",\'"$@"\'),shadow("grep","ugrep",\'"$@"\')].join("\\n")}';
const SNAPSHOT =
  ';function snapshot(){let $commands=snippets();if($commands!==null){const marker="FIND_GREP_FUNC_END";return $commands}return""}';
const RESOLVER =
  ';function resolver(){return{mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"}}';
const BT = '`';
const GREP_DESC = `;function gVr(e){if(xh(e))return${BT}Content search built on ripgrep. Bare identifiers.${BT};return${BT}A powerful search tool built on ripgrep. Full regex syntax.${BT}}`;

// Two Bash-description variants (concise + full), each ending the dedicated-tool
// bullet with the PRISTINE phrasing "Prefer dedicated tools over ${o} ..." (verified
// in the real cli.js backup) — the append target for the main agent. (The earlier
// fixture used "Prefer the dedicated tool.", which only exists in LCC overrides, so
// it gave false green while the public/default anchor matched nothing.)
const BASH_DESC =
  `;var bashHelp=[${BT}- Use Read to read files, not cat.${BT},` +
  `${BT}- Avoid search commands; prefer dedicated tools after verifying. Prefer dedicated tools over \${o} when one fits.${BT},` +
  `${BT}- \\\`timeout\\\` is in ms.${BT}];` +
  `var bashHelp2=[${BT}- Avoid cat/head/tail. Prefer dedicated tools over \${o} when one fits.${BT}];`;

// CC 2.1.215+ shape: the Grep description template carries a `${cond?`…`:""}`
// interpolation with a NESTED template. A naive "next unescaped backtick" scan
// stops on that nested template's OPENING backtick and splices into the ternary
// consequent, yielding `?  - Use …` → SyntaxError.
const GREP_DESC_NESTED =
  ';function gVr(e){return' +
  BT +
  'A powerful search tool built on ripgrep.\\n  - "count" shows match counts\\n' +
  '${vW()==="default"?' +
  BT +
  '  - Use ${qo} tool (if available) for open-ended searches\\n' +
  BT +
  ':""}  - Pattern syntax: rg-flavored\\n' +
  BT +
  '}';

const INSTRUCTIONS =
  ';async function*fffQuery($input,$events,$commands,$runner){let{systemPrompt:$base,userContext:$user,systemContext:$environment,canUseTool:$permission}=$input;' +
  'let $current=$input.toolUseContext,$selected={systemPrompt:$base},$routing={systemContext:$environment},$rows=[],$source="fixture",$stamp={};' +
  'let $wire=$identity($merge($selected.systemPrompt,$routing.systemContext)),$unused,$other,$entries,$copies,$record=()=>{let $next=$extra($rows,$entries,{options:$current.options,querySource:$source,stamp:$stamp,toolInputCopies:$copies});return $next};yield $wire;}' +
  ';async function fffContext($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,mainThreadAgentDefinition:$agent}=$details;' +
  'let $saved=$details.snapshot,$fallback=$details.prompt,$tools={};let $counted=$saved?.systemPrompt??$fallback,$descriptions=$tools?.toolDescriptions,$schemas=$tools?.toolEntries;return $counted;}' +
  ';function fffRender($rows,$visible=[],$model,$config){$rows=$fold($rows,$config?.accountMemoryWithheld,$memo(()=>$visible));let $output=[];for(let $row of $rows){' +
  'let $options={},$active=false,$result=$config?.withoutAttachmentHooks?$live($row,$options):$recorded($row,$options,$active),$rendered=$result.messages,{isKnownType:$known,recordedRole:$role}=$result;$output.push(...$rendered)}return $output;}';
const BASE = VISIBILITY + SHADOW + SETUP + SNAPSHOT + INSTRUCTIONS;
const COMBINED = BASE + RESOLVER + GREP_DESC + BASH_DESC;
const countOf = (source: string, part: string) => source.split(part).length - 1;
const shellCommands = (source: string, enabled = true): string[] =>
  new Function(
    'process',
    'searchGate',
    source + ';const result=snapshot();return result?result.split("\\n"):[];'
  )({ pid: 31415 }, () => enabled) as string[];

describe('native search visibility', () => {
  it('restores Grep and Glob without skipping permission and enabled filters', () => {
    const catalog =
      ';function catalog(tools,denied){return tools.filter(tool=>!hidden().has(tool.name)).filter(tool=>tool.enabled&&!denied.includes(tool.name))}';
    const source = restoreNativeSearchTools(VISIBILITY + catalog)!;
    const tools = [
      { name: 'Grep', enabled: true },
      { name: 'Glob', enabled: true },
      { name: 'Bash', enabled: true },
      { name: 'Disabled', enabled: false },
    ];
    const evaluate = (code: string, denied: string[]) =>
      new Function(
        'searchGate',
        'hasBash',
        'aliasFor',
        'tools',
        'denied',
        code + ';return catalog(tools,denied).map(tool=>tool.name);'
      )(
        () => true,
        () => true,
        () => undefined,
        tools,
        denied
      ) as string[];
    expect(evaluate(VISIBILITY + catalog, [])).toEqual(['Bash']);
    expect(evaluate(source, [])).toEqual(['Grep', 'Glob', 'Bash']);
    expect(evaluate(source, ['Grep'])).toEqual(['Glob', 'Bash']);
    expect(source).toContain(catalog);
    expect(restoreNativeSearchTools(source)).toBe(source);
  });

  it('requires an unambiguous omission set for the actual native tool names', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(restoreNativeSearchTools(VISIBILITY + VISIBILITY)).toBeNull();
      expect(
        restoreNativeSearchTools(VISIBILITY.replace('"Grep"', '"Edit"'))
      ).toBeNull();
      expect(restoreNativeSearchTools('unrelated')).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});

describe('swapRipgrepForFff', () => {
  it('keeps shell search generators and the native ripgrep resolver intact', () => {
    const patched = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    expect(patched).not.toBeNull();
    expect(patched).toContain(SHADOW);
    expect(patched).toContain(SETUP);
    expect(patched).toContain(RESOLVER);
    expect(patched).not.toContain('--fff-claude-bin=');
    expect(patched).not.toContain('fff locate');
    expect(hasFffShellIntegration(patched, WRAPPER)).toBe(true);
    expect(hasFffShellIntegration(patched, '/other-wrapper')).toBe(false);
    expect(() => new Function(patched)).not.toThrow();
    expect(writeSwapRipgrepForFff(patched, WRAPPER)).toBe(patched);
  });

  it('installs into the 2.1.314 snapshot line array', () => {
    const snapshot314 =
      ';function snapshot(){let $commands=snippets(),$end=`CLAUDE_CODE_END_${"x"}`,' +
      '$lines=["# head",...$commands!==null?["# Shadow find/grep with embedded bfs/ugrep",$commands]:[],"# tail"];' +
      'return $lines.join("\\n")}';
    const source = BASE.replace(SNAPSHOT, snapshot314);
    const patched = writeSwapRipgrepForFff(source, WRAPPER)!;
    expect(patched).not.toBeNull();
    expect(patched).toContain(SETUP);
    expect(patched).toContain(',$end=`CLAUDE_CODE_END_${"x"}`,');
    expect(patched).toContain(
      '...$commands!==null?["# Shadow find/grep with embedded bfs/ugrep",$commands]:[]'
    );
    expect(patched).toContain('snippets()].filter(Boolean).join("\\n"),$end=');
    expect(hasFffShellIntegration(patched, WRAPPER)).toBe(true);
    expect(writeSwapRipgrepForFff(patched, WRAPPER)).toBe(patched);
    const lines = shellCommands(patched);
    expect(lines[0]).toBe('# head');
    expect(lines[2]).toContain(`if [ -x '${WRAPPER}' ]; then`);
    expect(lines[2]).toContain('RG_FFF_SESSION=31415;');
    expect(lines).toContain('unalias find 2>/dev/null || true');
    expect(lines.at(-1)).toBe('# tail');
    const disabled = shellCommands(patched, false);
    expect(disabled[2]).toContain(`if [ -x '${WRAPPER}' ]; then`);
    expect(disabled).not.toContain('unalias find 2>/dev/null || true');
  });

  it('requires the 2.1.314 consumer to spread the producer result', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const unrelated =
        ';function snapshot(){let $commands=snippets(),$end=`CLAUDE_CODE_END_${"x"}`,' +
        '$lines=["# head"];return $lines.join("\\n")}';
      expect(
        writeSwapRipgrepForFff(BASE.replace(SNAPSHOT, unrelated), WRAPPER)
      ).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it('requires native tool visibility and unique shell setup', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        writeSwapRipgrepForFff(VISIBILITY + SHADOW + RESOLVER, WRAPPER)
      ).toBeNull();
      expect(writeSwapRipgrepForFff(BASE + SETUP, WRAPPER)).toBeNull();
      expect(writeSwapRipgrepForFff(BASE + SNAPSHOT, WRAPPER)).toBeNull();
      expect(
        writeSwapRipgrepForFff(VISIBILITY + SHADOW + SETUP, WRAPPER)
      ).toBeNull();
      expect(writeSwapRipgrepForFff(SHADOW + SETUP, WRAPPER)).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it('requires the real instruction hooks before reporting the feature applied', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const source = VISIBILITY + SHADOW + SETUP + SNAPSHOT;
      expect(writeSwapRipgrepForFff(source, WRAPPER)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        'patch: swapRipgrepForFff: failed to find unique scoped search instruction boundaries'
      );
      const patched = writeSwapRipgrepForFff(BASE, WRAPPER)!;
      expect(patched).toContain('function __tweakccFffPrompt');
      expect(patched).toContain('function __tweakccFffAutoMode');
      expect(patched).toContain(FFF_PROJECT_GUIDANCE);
      expect(() => new Function(patched)).not.toThrow();
    } finally {
      error.mockRestore();
    }
  });

  it('refuses legacy interception instead of leaving native searches redirected', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const legacy of [
        'export RG_FFF_SESSION="${process.pid}"; local _cc_bin=',
        'args:["--fff-claude-bin="+process.execPath]',
      ]) {
        expect(writeSwapRipgrepForFff(BASE + legacy, WRAPPER)).toBeNull();
      }
      expect(error).toHaveBeenCalledWith(
        'patch: swapRipgrepForFff: legacy search interception requires applying from pristine Claude Code'
      );
    } finally {
      error.mockRestore();
    }
  });

  it('keeps native descriptions intact and confines guidance to request hooks', () => {
    const patched = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    expect(patched).toContain(GREP_DESC);
    expect(patched).toContain(BASH_DESC);
    expect(countOf(patched, 'Native Grep navigation:')).toBe(0);
    expect(countOf(patched, 'Native search and fff files:')).toBe(0);
    expect(patched).toContain(FFF_PROJECT_GUIDANCE);
    for (const stale of [
      'most-relevant-first',
      'likely declarations first',
      'After two locating searches',
      'grep --fuzzy',
      '[def]',
      'interleave',
    ]) {
      expect(patched).not.toContain(stale);
    }
  });

  it('preserves custom Grep descriptions at the tool boundary', async () => {
    const custom =
      ';async function customPrompt(model,lean){return lean?"My concise grep instructions.":"My full grep instructions."}' +
      ';var tool={searchHint:"search file contents with regex (ripgrep)",async description(){return customPrompt(void 0)},async prompt({model:$model,leanPrompt:$lean}){return customPrompt($model,$lean)},create(){return{}}};';
    const patched = writeSwapRipgrepForFff(BASE + custom, WRAPPER)!;
    const tool = new Function(patched + ';return tool;')() as {
      description: () => Promise<string>;
      prompt: (input: { leanPrompt: boolean }) => Promise<string>;
    };
    for (const leanPrompt of [true, false]) {
      const prompt = await tool.prompt({ leanPrompt });
      expect(prompt).toBe(
        leanPrompt
          ? 'My concise grep instructions.'
          : 'My full grep instructions.'
      );
      expect(countOf(prompt, 'Native Grep navigation:')).toBe(0);
      expect(prompt).not.toContain('[object Promise]');
    }
    expect(await tool.description()).toBe('My full grep instructions.');
    expect(writeSwapRipgrepForFff(patched, WRAPPER)).toBe(patched);
  });

  it.each([
    [
      'Custom lean overview.',
      'Executes a given bash command and returns its output.',
    ],
    [
      'Executes a bash command and returns its output.',
      'Custom full overview.',
    ],
    ['Custom lean overview.', 'Custom full overview.'],
  ])(
    'preserves overridden Bash headers %s / %s',
    async (leanHeader, fullHeader) => {
      const separatePrompt =
        ';var separatePrompt=`Prefer dedicated tools over shell commands.`;';
      const custom =
        ';async function makeBash(model,allowed,tools,lean,trimmed){return(lean?' +
        JSON.stringify(leanHeader) +
        ':' +
        JSON.stringify(fullHeader) +
        ')+(trimmed?"":" Custom tool instructions.")}' +
        ';async function allowedTools(tools){return tools}' +
        ';var tool={searchHint:"execute shell commands",async description({description:value}){return value||"Run shell command"},async prompt({model:$model,tools:$tools,leanPrompt:$lean,bashFirstTrimmed:$trimmed}){return makeBash($model,await allowedTools($tools),$tools,$lean,$trimmed)},isConcurrencySafe(){return false}};' +
        separatePrompt;
      const patched = writeSwapRipgrepForFff(BASE + custom, WRAPPER)!;
      const tool = new Function(patched + ';return tool;')() as {
        description: (input: { description?: string }) => Promise<string>;
        prompt: (input: {
          leanPrompt: boolean;
          bashFirstTrimmed: boolean;
        }) => Promise<string>;
      };
      for (const leanPrompt of [true, false]) {
        for (const bashFirstTrimmed of [true, false]) {
          const description = await tool.prompt({
            leanPrompt,
            bashFirstTrimmed,
          });
          expect(description).toBe(
            (leanPrompt ? leanHeader : fullHeader) +
              (bashFirstTrimmed ? '' : ' Custom tool instructions.')
          );
          expect(description.includes('Custom tool instructions.')).toBe(
            !bashFirstTrimmed
          );
          expect(countOf(description, 'Native search and fff files:')).toBe(0);
          expect(description).not.toContain('[object Promise]');
        }
      }
      expect(await tool.description({})).toBe('Run shell command');
      expect(await tool.description({ description: 'My command' })).toBe(
        'My command'
      );
      expect(patched).toContain(separatePrompt);
      expect(writeSwapRipgrepForFff(patched, WRAPPER)).toBe(patched);
    }
  );

  it('preserves Bash description arrays when custom bullets are hidden', async () => {
    const custom =
      ';async function lean(hide){let notes=[];if(!hide)notes.push("Custom lean instructions.");return["Executes a bash command and returns its output.",...notes].join("\\n")}' +
      ';async function full(hide){let notes=[];if(!hide)notes.push("Custom full instructions.");return["Executes a given bash command and returns its output.",...notes].join("\\n")}';
    const patched = writeSwapRipgrepForFff(BASE + custom, WRAPPER)!;
    const descriptions = new Function(patched + ';return{lean,full}')() as {
      lean: (hide: boolean) => Promise<string>;
      full: (hide: boolean) => Promise<string>;
    };
    for (const make of [descriptions.lean, descriptions.full]) {
      for (const hide of [true, false]) {
        const description = await make(hide);
        expect(description).toMatch(
          /^Executes (a|a given) bash command and returns its output\./
        );
        expect(countOf(description, 'Native search and fff files:')).toBe(0);
        if (!hide) expect(description).toContain('Custom');
      }
    }
    expect(writeSwapRipgrepForFff(patched, WRAPPER)).toBe(patched);
  });

  it('preserves native nested description templates', () => {
    const patched = writeSwapRipgrepForFff(BASE + GREP_DESC_NESTED, WRAPPER)!;
    expect(() => new Function(patched)).not.toThrow();
    expect(countOf(patched, 'Native Grep navigation:')).toBe(0);
    expect(patched).toContain(GREP_DESC_NESTED);
  });

  it('does not search description templates for guidance insertion', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const source = BASE + ';var description=`unterminated, built on ripgrep';
      const patched = writeSwapRipgrepForFff(source, WRAPPER)!;
      expect(patched).not.toBeNull();
      expect(patched).not.toContain('Native Grep navigation:');
      expect(patched).toContain(
        ';var description=`unterminated, built on ripgrep'
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('executes literal wrapper paths through Bash and zsh without affecting native functions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fff-shell-path-'));
    try {
      const directory = path.join(
        root,
        "José ' $HOME ${HOME} $(touch injected) `touch injected` \\"
      );
      await fs.mkdir(directory);
      const wrapper = path.join(directory, 'rg-fff');
      await fs.writeFile(
        wrapper,
        '#!/bin/sh\nprintf "%s\\n" "$RG_FFF_SESSION" "$@"\n',
        {
          mode: 0o700,
        }
      );
      const patched = writeSwapRipgrepForFff(BASE, wrapper)!;
      expect(patched).not.toContain('José');
      expect(patched).toContain('Jos\\u00e9');
      expect(countOf(patched, ' --warmup ')).toBe(1);
      for (const enabled of [true, false]) {
        const commands = shellCommands(patched, enabled);
        expect(commands.slice(1)).toEqual(shellCommands(BASE, enabled));
        expect(commands.join('\n').includes('function grep')).toBe(enabled);
        expect(commands.join('\n').includes('function find')).toBe(enabled);
        for (const executable of ['/bin/bash', '/bin/zsh']) {
          const result = spawnSync(
            executable,
            ['-c', commands.join('\n') + '\nfff files "literal argument"'],
            { cwd: root, encoding: 'utf8' }
          );
          if (!result.error) {
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toBe('31415\nfiles\nliteral argument\n');
            expect(result.stderr).toBe('');
          }
        }
      }
      await expect(fs.stat(path.join(root, 'injected'))).rejects.toThrow();
      expect(writeSwapRipgrepForFff(patched, wrapper)).toBe(patched);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps shell setup working when the optional filename wrapper is absent', () => {
    const patched = writeSwapRipgrepForFff(BASE, '/missing/rg-fff')!;
    const commands = shellCommands(patched).join('\n');
    for (const executable of ['/bin/bash', '/bin/zsh']) {
      const result = spawnSync(
        executable,
        [
          '-c',
          commands +
            '\nif typeset -f fff >/dev/null; then exit 3; fi; printf task',
        ],
        { encoding: 'utf8' }
      );
      if (!result.error) {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('task');
        expect(result.stderr).toBe('');
      }
    }
  });
});
