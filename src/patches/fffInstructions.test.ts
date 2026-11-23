import { describe, expect, it, vi } from 'vitest';
import {
  FFF_BASH_GUIDANCE,
  composeFffToolDescription,
  normalizeFffAutoMode,
  normalizeRecordedPrompt,
  writeFffInstructions,
} from './fffInstructions';
import { FFF_OWNED_PROJECT_GUIDANCE } from './fffInstructionSuffixes';

const SERIALIZER =
  ';async function $describe($tool,$options){let $cached=$options.cached??{description:await $tool.prompt(),input_schema:$tool.input_schema},$entry=$options.recordedEntry,$redescribed=$options.isRedescribed===true,$result={name:$tool.name,description:$redescribed?$cached.description:$entry?.description??$options.recordedDescription??$cached.description,input_schema:$entry?.input_schema??$cached.input_schema};return $result;}';

const API_SITE =
  'let $wire=$identity($merge($selected.systemPrompt,$routing.systemContext)),$unused,$other,$entries,$copies,$record=()=>{let $next=$extra($rows,$entries,{options:$current.options,querySource:$source,stamp:$stamp,toolInputCopies:$copies});return $next};';
const API =
  'async function*$query($input,$events,$commands,$runner){let{systemPrompt:$base,userContext:$user,systemContext:$environment,canUseTool:$permission}=$input;' +
  'let $current=$input.toolUseContext,$selected=$input.snapshot??{systemPrompt:$base},$routing={systemContext:$environment},$rows=[],$source="fixture",$stamp={};' +
  API_SITE +
  'yield{systemPrompt:$wire,tools:$current.options.tools,snapshot:$selected};}';
const CONTEXT_SITE =
  'let $counted=$snapshot?.systemPrompt??$default,$descriptions=$tools?.toolDescriptions,$schemas=$tools?.toolEntries;';
const CONTEXT =
  ';async function $context($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,mainThreadAgentDefinition:$agent}=$details;' +
  'let $snapshot=$details.snapshot,$default=$details.prompt,$tools={};' +
  CONTEXT_SITE +
  'return $counted;}';
const RENDER_SITE =
  'let $options={},$active=false,$result=$config?.withoutAttachmentHooks?$live($row,$options):$recorded($row,$options,$active),$rendered=$result.messages,{isKnownType:$known,recordedRole:$role}=$result;';
const RENDER =
  ';function $render($rows,$visible=[],$model,$config){$rows=$fold($rows,$config?.accountMemoryWithheld,$memo(()=>$visible));let $output=[];for(let $row of $rows){' +
  RENDER_SITE +
  '$output.push(...$rendered)}return $output;}';
const PRISTINE = API + CONTEXT + RENDER + SERIALIZER;
const TOOLS = [{ name: 'Bash' }, { name: 'Glob' }, { name: 'Grep' }];

type Message = {
  type?: string;
  isMeta?: boolean;
  message: { role?: string; content: string | unknown[] };
};

type Fixture = {
  $describe: (
    tool: { name: string; prompt: () => Promise<string>; input_schema: object },
    options: {
      cached?: { description: string; input_schema: object };
      recordedDescription?: string;
      recordedEntry?: { description: string; input_schema: object };
      isRedescribed?: boolean;
    }
  ) => Promise<{ name: string; description: string; input_schema: object }>;
  $query: (input: {
    systemPrompt: string[];
    userContext: object;
    systemContext: string[];
    canUseTool: undefined;
    toolUseContext: { options: { tools: { name: string }[] } };
    snapshot?: { systemPrompt: string[] };
  }) => AsyncGenerator<{ systemPrompt: string[] }>;
  $context: (
    messages: unknown[],
    model: string,
    permissions: object,
    tools: { name: string }[],
    agents: unknown[],
    details: { prompt: string[]; snapshot?: { systemPrompt: string[] } }
  ) => Promise<string[]>;
  $render: (
    rows: { attachment: { type: string }; messages: Message[] }[],
    tools: { name: string }[],
    model: undefined,
    options?: { withoutAttachmentHooks: boolean }
  ) => Message[];
};

const evaluate = (source: string): Fixture =>
  new Function(
    '$identity',
    '$merge',
    '$extra',
    '$fold',
    '$memo',
    '$live',
    '$recorded',
    source + ';return{$query,$context,$render,$describe};'
  )(
    (value: unknown) => value,
    (prompt: string[], environment: string[]) => [...prompt, ...environment],
    () => undefined,
    (rows: unknown) => rows,
    (callback: () => unknown) => callback(),
    (row: { messages: Message[] }) => ({ messages: row.messages }),
    (row: { messages: Message[] }) => ({
      messages: row.messages,
      isKnownType: true,
      recordedRole: 'system',
    })
  ) as Fixture;

const query = async (
  fixture: Fixture,
  prompt: string[],
  tools = TOOLS,
  snapshot?: { systemPrompt: string[] }
): Promise<string[]> => {
  const result = await fixture
    .$query({
      systemPrompt: prompt,
      userContext: {},
      systemContext: ['environment'],
      canUseTool: undefined,
      toolUseContext: { options: { tools } },
      snapshot,
    })
    .next();
  return result.value.systemPrompt;
};

describe('fff instruction runtime', () => {
  it('composes one Bash note and preserves native text and other tools', () => {
    const native = 'Custom shell instructions. Use exact search here.';
    const first = composeFffToolDescription(native, 'Bash', FFF_BASH_GUIDANCE);
    expect(first).toBe(native + '\n\n' + FFF_BASH_GUIDANCE);
    expect(composeFffToolDescription(first, 'Bash', FFF_BASH_GUIDANCE)).toBe(
      first
    );
    expect(
      composeFffToolDescription(
        first + '\n\n' + FFF_BASH_GUIDANCE,
        'Bash',
        FFF_BASH_GUIDANCE
      )
    ).toBe(first);
    for (const name of ['Grep', 'Read', 'mcp__custom__Bash', undefined]) {
      expect(composeFffToolDescription(native, name, FFF_BASH_GUIDANCE)).toBe(
        native
      );
    }
    expect(
      composeFffToolDescription(undefined, 'Bash', FFF_BASH_GUIDANCE)
    ).toBeUndefined();
    expect(composeFffToolDescription(native, 'Bash', '  ')).toBe(native);
  });

  it('strips only complete owned root fragments without mutating saved prompts', () => {
    const custom = 'FFF project navigation: custom instructions.';
    const original = [
      'Custom instructions.',
      ...FFF_OWNED_PROJECT_GUIDANCE,
      custom,
    ];
    expect(
      normalizeRecordedPrompt(original, FFF_OWNED_PROJECT_GUIDANCE)
    ).toEqual(['Custom instructions.', custom]);
    expect(original).toHaveLength(4);
    const clean = ['native'];
    expect(normalizeRecordedPrompt(clean, FFF_OWNED_PROJECT_GUIDANCE)).toBe(
      clean
    );
  });

  it.each([undefined, null, {}, 'custom string', ['valid', 3]])(
    'leaves unsupported prompt inputs unchanged: %s',
    prompt => {
      expect(normalizeRecordedPrompt(prompt, FFF_OWNED_PROJECT_GUIDANCE)).toBe(
        prompt
      );
    }
  );

  it.each(['strict', 'relaxed'])(
    'redirects only the %s auto-mode search clause to the Bash description',
    variant => {
      const prefix =
        variant === 'strict'
          ? 'Do your work through Bash wherever it can accomplish the job: '
          : 'You can do much of your work through Bash when it is simpler: ';
      const text =
        prefix +
        'read files with cat, search with grep and find, and make changes with sed. Permissions and edit rules stay here.';
      const original = [
        { isMeta: true, message: { role: 'user', content: text } },
      ];
      const result = normalizeFffAutoMode(
        original,
        { type: 'auto_mode' },
        TOOLS,
        FFF_BASH_GUIDANCE
      ) as Message[];
      expect(
        (result[0].message.content as string).replace(
          'search following the Bash tool description',
          'search with grep and find'
        )
      ).toBe(text);
      expect(result[0].isMeta).toBe(true);
      expect(original[0].message.content).toBe(text);
      expect(result[0].message.content).not.toContain('fff files');
      expect(
        normalizeFffAutoMode(
          result,
          { type: 'auto_mode' },
          TOOLS,
          FFF_BASH_GUIDANCE
        )
      ).toBe(result);
    }
  );

  it('preserves mixed content and requires Bash availability for auto-mode', () => {
    const image = { type: 'image', source: { synthetic: true } };
    const untouched = {
      type: 'text',
      text: 'Permission and edit instructions.',
    };
    const original = [
      {
        message: {
          content: [
            untouched,
            { type: 'text', text: 'search with grep and find' },
            image,
          ],
        },
      },
    ];
    const result = normalizeFffAutoMode(
      original,
      { type: 'auto_mode' },
      [{ name: 'Bash' }],
      FFF_BASH_GUIDANCE
    ) as Message[];
    const content = result[0].message.content as { text?: string }[];
    expect(content[0]).toBe(untouched);
    expect(content[2]).toBe(image);
    expect(content[1].text).toBe('search following the Bash tool description');
    expect(
      normalizeFffAutoMode(
        original,
        { type: 'plan_mode' },
        TOOLS,
        FFF_BASH_GUIDANCE
      )
    ).toBe(original);
    expect(
      normalizeFffAutoMode(
        original,
        { type: 'auto_mode' },
        [{ name: 'Grep' }],
        FFF_BASH_GUIDANCE
      )
    ).toBe(original);
  });
});

describe('fff scoped instruction patch', () => {
  it('composes live, cached, restored, and redescribed Bash entries at the shared serializer', async () => {
    const patched = writeFffInstructions(PRISTINE)!;
    expect(patched).not.toBeNull();
    const fixture = evaluate(patched);
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
    };
    const prompt = vi.fn(async () => 'Native full or lean description.');
    for (const name of ['Bash', 'Grep', 'Read', 'mcp__custom__Bash']) {
      const tool = { name, prompt, input_schema: schema };
      for (const options of [
        {},
        {
          cached: { description: 'Cached native text.', input_schema: schema },
        },
        { recordedDescription: 'Forked description.' },
        {
          recordedEntry: {
            description: 'Saved description.',
            input_schema: schema,
          },
        },
        {
          recordedEntry: {
            description: 'Saved description.\n\n' + FFF_BASH_GUIDANCE,
            input_schema: schema,
          },
        },
        { isRedescribed: true, recordedDescription: 'Old override.' },
      ]) {
        const result = await fixture.$describe(tool, options);
        const pristine = await evaluate(PRISTINE).$describe(tool, options);
        expect(result.input_schema).toBe(pristine.input_schema);
        expect(result.name).toBe(name);
        expect(result.description).toBe(
          name === 'Bash'
            ? pristine.description.replaceAll('\n\n' + FFF_BASH_GUIDANCE, '') +
                '\n\n' +
                FFF_BASH_GUIDANCE
            : pristine.description
        );
      }
    }
    expect(writeFffInstructions(patched)).toBe(patched);
  });

  it('leaves root prompts and snapshot arrays unchanged and gates guidance on the tool name', async () => {
    const patched = writeFffInstructions(PRISTINE)!;
    const fixture = evaluate(patched);
    const snapshot = { systemPrompt: ['old saved prompt'] };
    expect(await query(fixture, ['live'], TOOLS, snapshot)).toEqual([
      'old saved prompt',
      'environment',
    ]);
    expect(
      await fixture.$context([], 'model', {}, TOOLS, [], {
        prompt: ['live'],
        snapshot,
      })
    ).toBe(snapshot.systemPrompt);
    expect(await query(fixture, ['custom'], [{ name: 'Read' }])).toEqual([
      'custom',
      'environment',
    ]);
    expect(snapshot.systemPrompt).toEqual(['old saved prompt']);
    expect(patched).not.toContain('__tweakccRecordedPrompt');
    const read = await fixture.$describe(
      { name: 'Read', prompt: async () => 'Read.', input_schema: {} },
      {}
    );
    expect(read.description).toBe('Read.');
  });

  it.each(['auto', 'bypass'])(
    'redirects current and recorded %s attachment searches without repeating the note',
    mode => {
      const fixture = evaluate(writeFffInstructions(PRISTINE)!);
      const text = `${mode}: search with grep and find; permission text; edit text.`;
      const messages = [{ type: 'user', message: { content: text } }];
      for (const withoutAttachmentHooks of [false, true]) {
        const rows = [{ attachment: { type: 'auto_mode' }, messages }];
        const rendered = fixture.$render(rows, TOOLS, undefined, {
          withoutAttachmentHooks,
        });
        expect(rendered[0].message.content).toBe(
          `${mode}: search following the Bash tool description; permission text; edit text.`
        );
        expect(messages[0].message.content).toBe(text);
        expect(fixture.$render(rows, [{ name: 'Read' }], undefined)[0]).toBe(
          messages[0]
        );
      }
    }
  );

  it('binds the 2.1.319 renderer without a tools default and with a fifth parameter', () => {
    const render319 = RENDER.replace(
      'function $render($rows,$visible=[],$model,$config)',
      'function $render($rows,$visible,$model,$config,$extra)'
    );
    expect(render319).not.toBe(RENDER);
    const source = PRISTINE.replace(RENDER, render319);
    const patched = writeFffInstructions(source)!;
    expect(patched).not.toBeNull();
    expect(patched).toContain('__tweakccFffAutoMode');
    expect(patched).toContain('.attachment,$visible,"');
    const fixture = evaluate(patched);
    const text = 'auto: search with grep and find; permission text.';
    const messages = [{ type: 'user', message: { content: text } }];
    const rows = [{ attachment: { type: 'auto_mode' }, messages }];
    expect(fixture.$render(rows, TOOLS, undefined)[0].message.content).toBe(
      'auto: search following the Bash tool description; permission text.'
    );
    expect(fixture.$render(rows, [{ name: 'Read' }], undefined)[0]).toBe(
      messages[0]
    );
    expect(writeFffInstructions(patched)).toBe(patched);
  });

  it('preserves pristine serializer behavior with the feature disabled', async () => {
    const fixture = evaluate(PRISTINE);
    const tool = {
      name: 'Bash',
      prompt: async () => 'Native Bash.',
      input_schema: {},
    };
    expect((await fixture.$describe(tool, {})).description).toBe(
      'Native Bash.'
    );
    expect(PRISTINE).not.toContain('__tweakccFff');
  });

  it('serializes explicit guidance without closures or template interpolation', async () => {
    const guidance = 'Synthetic `code` ${placeholder} \\ "quoted" é text.';
    const patched = writeFffInstructions(PRISTINE, guidance)!;
    expect(patched).not.toContain('é');
    const result = await evaluate(patched).$describe(
      { name: 'Bash', prompt: async () => 'Native.', input_schema: {} },
      {}
    );
    expect(result.description).toBe('Native.\n\n' + guidance);
    expect(writeFffInstructions(patched, guidance)).toBe(patched);
  });

  it('bounds the renderer parser across braces in strings, regexes, and templates', () => {
    const source = PRISTINE.replace(
      RENDER_SITE,
      'let $braces="}",$regex=/[{}]/,$template=`${"}"}`;' + RENDER_SITE
    );
    expect(writeFffInstructions(source)).not.toBeNull();
  });

  it.each([
    ['missing serializer', PRISTINE.replace(SERIALIZER, '')],
    ['duplicate serializer', PRISTINE + SERIALIZER],
    [
      'changed serializer',
      PRISTINE.replace('$entry?.description??', '$entry.description??'),
    ],
    ['missing renderer scope', PRISTINE.replace(RENDER, '')],
    ['ambiguous renderer scope', PRISTINE + RENDER],
    ['missing renderer initializer', PRISTINE.replace(RENDER_SITE, '')],
    [
      'neighboring renderer initializer',
      PRISTINE.replace(RENDER_SITE, '') +
        ';function $neighbor(){' +
        RENDER_SITE +
        '}',
    ],
    [
      'nested renderer initializer',
      PRISTINE.replace(RENDER_SITE, 'function $nested(){' + RENDER_SITE + '}'),
    ],
    [
      'ambiguous renderer initializer',
      PRISTINE.replace(
        RENDER_SITE,
        '{' + RENDER_SITE + '}{' + RENDER_SITE + '}'
      ),
    ],
  ])('rejects %s without partial edits', (_name, source) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(writeFffInstructions(source)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        'patch: swapRipgrepForFff: failed to find unique scoped search instruction boundaries'
      );
    } finally {
      error.mockRestore();
    }
  });
});
