import { describe, expect, it, vi } from 'vitest';
import {
  FFF_BASH_GUIDANCE,
  normalizeFffRecordedTools,
  writeFffInstructionHygiene,
  writeFffInstructions,
} from './fffInstructions';
import {
  FFF_OWNED_PROJECT_GUIDANCE,
  FFF_OWNED_TOOL_GUIDANCE_SUFFIXES,
} from './fffInstructionSuffixes';

const SERIALIZER =
  ';async function $describe($tool,$options){let $cached=$options.cached??{description:await $tool.prompt(),input_schema:$tool.input_schema},$entry=$options.recordedEntry,$redescribed=$options.isRedescribed===true,$result={name:$tool.name,description:$redescribed?$cached.description:$entry?.description??$options.recordedDescription??$cached.description,input_schema:$entry?.input_schema??$cached.input_schema};return $result;}';

const API_SITE =
  'let{advisorModel:$advisor,advisorDeferred:$deferred,advisorActive:$active}=$changes,$selected=$choose($rows,$base,{options:$current.options,querySource:$source,resumeActive:$resume,stamp:$stamp,inheritedReminderFold:()=>$restore($rows)?.reminderFold,inheritedWireShape:()=>$restore($rows)?.wireShape,inheritedEchoWireToolInputs:()=>$restore($rows)?.echoWireToolInputs,contextRendering:$routing.rendering});';
const API =
  'async function*$query($input,$events,$commands,$runner){let{systemPrompt:$base,userContext:$user,systemContext:$environment,canUseTool:$permission}=$input;' +
  'let $current=$input.toolUseContext,$rows=$input.messages,$source="fixture",$resume=$input.resumeActive,$stamp={},$changes={},$routing={systemContext:$environment};' +
  API_SITE +
  'if($selected.record)yield{kind:"record",value:$selected.record};' +
  'let $wire=$identity($merge($selected.systemPrompt,$routing.systemContext)),$unused,$other,$entries,$copies,$record=()=>{let $next=$extra($rows,$entries,{options:$current.options,querySource:$source,stamp:$stamp,toolInputCopies:$copies});return $next};' +
  'yield{kind:"request",value:{systemPrompt:$wire,options:{recordedToolDescriptions:$selected.toolDescriptions,recordedToolEntries:$selected.toolEntries},snapshot:$selected}};}';
const CONTEXT_SITE =
  '$snapshot=$active($rows,$current.options),$tools=$recorded($rows,$current.options)';
const CONTEXT =
  ';async function $context($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,mainThreadAgentDefinition:$agent}=$details;' +
  'let $default=$details.prompt,$snapshot,$tools;if($current!==void 0){let $rows=$messagesOf($messages);' +
  CONTEXT_SITE +
  '}let $counted=$snapshot?.systemPrompt??$default,$descriptions=$tools?.toolDescriptions,$schemas=$tools?.toolEntries;' +
  'return{systemPrompt:$counted,toolDescriptions:$descriptions,toolEntries:$schemas,snapshot:$snapshot};}';
const RENDER =
  ';function $render($rows,$visible=[],$model,$config){$rows=$fold($rows,$config?.accountMemoryWithheld,$memo(()=>$visible));let $output=[];for(let $row of $rows){let $options={},$active=false,$result=$config?.withoutAttachmentHooks?$live($row,$options):$recordedRender($row,$options,$active),$rendered=$result.messages,{isKnownType:$known,recordedRole:$role}=$result;$output.push(...$rendered)}return $output;}';
const PRISTINE =
  API + CONTEXT + RENDER + SERIALIZER + ';var $type="prompt_snapshot";';
const API_HEAD = 'canUseTool:$permission}=$input;';
const API_2_1_299 =
  API.slice(0, API.indexOf(API_HEAD) + API_HEAD.length) +
  'let $state={toolUseContext:$input.toolUseContext},$pending=[];async function*$loop(){if($state&&$state.toolUseContext.shouldStopBeforeNextApiCall?.())return yield*$pending,{reason:"background_requested"};' +
  API.slice(API.indexOf(API_HEAD) + API_HEAD.length, -1)
    .replace(
      '=$changes,$selected=',
      '=$changes,$recall=()=>$rows?$restore($rows):void 0,$selected='
    )
    .replace(
      'contextRendering:$routing.rendering}',
      'contextRendering:$routing.rendering,toolDescribeEpoch:$stamp,turnSections:$source}'
    ) +
  '}yield*$loop()}';
const RENDER_2_1_299 = RENDER.replace(
  '$memo(()=>$visible));',
  '$memo(()=>$visible)),$rows=$tidy($rows);'
);
const PRISTINE_2_1_299 =
  API_2_1_299 +
  CONTEXT +
  RENDER_2_1_299 +
  SERIALIZER +
  ';var $type="prompt_snapshot";';
const API_2_1_314 = API_2_1_299.replace(
  'let $state={toolUseContext:$input.toolUseContext},$pending=[];async function*$loop(){if(',
  'let $state={toolUseContext:$input.toolUseContext},$pending=[],$halted=false,$note=()=>{};async function*$loop(){if($halted)return yield*$pending,$note($state.toolUseContext),{reason:"hook_stopped"};if('
);
const PRISTINE_2_1_314 =
  API_2_1_314 +
  CONTEXT +
  RENDER_2_1_299 +
  SERIALIZER +
  ';var $type="prompt_snapshot";';
// CC 2.1.322: the context function has six parameters and destructures
// `originalMessages:` (plus further options) after `toolUseContext:`.
const CONTEXT_2_1_322 = CONTEXT.replace(
  ';async function $context($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,mainThreadAgentDefinition:$agent}=$details;',
  ';async function $context($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,originalMessages:$original,configuredWindow:$window,detail:$detail="full"}=$details;'
);
const PRISTINE_2_1_322 =
  API_2_1_314 +
  CONTEXT_2_1_322 +
  RENDER_2_1_299 +
  SERIALIZER +
  ';var $type="prompt_snapshot";';
const TOOLS = [{ name: 'Bash' }, { name: 'Grep' }, { name: 'Glob' }];

type Entry = {
  name: string;
  description: string;
  input_schema: object;
  [key: string]: unknown;
};
type Snapshot = {
  systemPrompt: string[];
  toolDescriptions?: Map<string, unknown>;
  toolEntries?: Map<string, Entry>;
  record?: unknown;
  [key: string]: unknown;
};
type Request = {
  systemPrompt: string[];
  options: {
    recordedToolDescriptions: Map<string, string>;
    recordedToolEntries: Map<string, Entry>;
  };
  snapshot: Snapshot;
};
type Fixture = {
  $describe: (
    tool: { name: string; prompt: () => Promise<string>; input_schema: object },
    options: { recordedDescription?: unknown; recordedEntry?: Entry }
  ) => Promise<Entry>;
  $query: (input: {
    systemPrompt: string[];
    systemContext: string[];
    toolUseContext: { options: { tools: typeof TOOLS } };
    messages: Snapshot[];
    resumeActive: boolean;
  }) => AsyncGenerator<{
    kind: 'record' | 'request';
    value: Request | unknown;
  }>;
  $context: (
    messages: Snapshot[],
    model: string,
    permissions: object,
    tools: typeof TOOLS,
    agents: unknown[],
    details: {
      prompt: string[];
      toolUseContext: { options: { tools: typeof TOOLS } };
    }
  ) => Promise<Snapshot>;
};

const evaluate = (source: string): Fixture =>
  new Function(
    '$choose',
    '$restore',
    '$identity',
    '$merge',
    '$extra',
    '$active',
    '$recorded',
    '$messagesOf',
    source + ';return{$query,$context,$describe};'
  )(
    (rows: Snapshot[], prompt: string[]) => rows[0] ?? { systemPrompt: prompt },
    (rows: Snapshot[]) => rows[0],
    (value: unknown) => value,
    (prompt: string[], environment: string[]) => [...prompt, ...environment],
    () => undefined,
    (rows: Snapshot[]) => rows[0],
    (rows: Snapshot[]) => rows[0],
    (rows: Snapshot[]) => rows
  ) as Fixture;

const request = async (
  fixture: Fixture,
  snapshot: Snapshot
): Promise<{ request: Request; records: unknown[] }> => {
  const records: unknown[] = [];
  let result: Request | undefined;
  for await (const row of fixture.$query({
    systemPrompt: ['custom override'],
    systemContext: ['environment'],
    toolUseContext: { options: { tools: TOOLS } },
    messages: [snapshot],
    resumeActive: true,
  })) {
    if (row.kind === 'record') records.push(row.value);
    else result = row.value as Request;
  }
  if (!result) throw new Error('No request');
  return { request: result, records };
};

const clean = (snapshot: unknown): unknown =>
  normalizeFffRecordedTools(snapshot, FFF_OWNED_TOOL_GUIDANCE_SUFFIXES);

describe('fff saved tool guidance hygiene', () => {
  it('preserves fresh snapshots by identity', () => {
    const snapshot: Snapshot = {
      systemPrompt: ['native system prompt'],
      toolDescriptions: new Map([['Bash', 'Native shell instructions.']]),
      toolEntries: new Map([
        [
          'Grep',
          { name: 'Grep', description: 'Native search.', input_schema: {} },
        ],
      ]),
    };
    expect(clean(snapshot)).toBe(snapshot);
    expect(clean({ systemPrompt: ['custom'] })).toEqual({
      systemPrompt: ['custom'],
    });
  });

  it.each(
    Object.entries(FFF_OWNED_TOOL_GUIDANCE_SUFFIXES).flatMap(([name, blocks]) =>
      blocks.map((block, index) => ({ name, block, index }))
    )
  )('removes the complete known $name block $index', ({ name, block }) => {
    const entry = {
      name,
      description: 'Native text.' + block,
      input_schema: { type: 'object' },
    };
    const snapshot = {
      toolDescriptions: new Map([[name, 'Native text.' + block]]),
      toolEntries: new Map([[name, entry]]),
    };
    const normalized = clean(snapshot) as Snapshot;
    expect(normalized.toolDescriptions?.get(name)).toBe('Native text.');
    expect(normalized.toolEntries?.get(name)?.description).toBe('Native text.');
    expect(normalized.toolEntries?.get(name)?.input_schema).toBe(
      entry.input_schema
    );
    expect(clean(normalized)).toBe(normalized);
    expect(snapshot.toolDescriptions.get(name)).toBe('Native text.' + block);
    expect(entry.description).toBe('Native text.' + block);
  });

  it('removes inline owned blocks while preserving surrounding native text', () => {
    const block = FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Bash[1];
    const snapshot = {
      toolDescriptions: new Map([
        ['Bash', 'First native bullet.' + block + '\nLast native bullet.'],
      ]),
    };
    const normalized = clean(snapshot) as Snapshot;
    expect(normalized.toolDescriptions?.get('Bash')).toBe(
      'First native bullet.\nLast native bullet.'
    );
  });

  it('removes the legacy array-header bullet with its single newline', () => {
    const header = 'Executes a bash command and returns its output.';
    const custom = 'Custom tool instructions.';
    const block = FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Bash[0].slice(2);
    const original = [header, block, custom].join('\n');
    const snapshot = {
      toolDescriptions: new Map([['Bash', original]]),
      toolEntries: new Map([
        ['Bash', { name: 'Bash', description: original, input_schema: {} }],
      ]),
    };
    const normalized = clean(snapshot) as Snapshot;
    expect(normalized.toolDescriptions?.get('Bash')).toBe(
      [header, custom].join('\n')
    );
    expect(normalized.toolEntries?.get('Bash')?.description).toBe(
      [header, custom].join('\n')
    );
    expect(snapshot.toolDescriptions.get('Bash')).toBe(original);
  });

  it('preserves similar custom text, other names, and unknown versions', () => {
    const exact = FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Grep[0];
    const descriptions = new Map([
      ['Grep', 'Custom text.' + exact.replace('broad', 'specific')],
      ['Bash', 'Native search and fff files: Custom instructions.'],
      ['Read', 'Read instructions.' + exact],
      ['mcp__custom__Grep', 'Custom tool.' + exact],
    ]);
    const snapshot = { toolDescriptions: descriptions };
    expect(clean(snapshot)).toBe(snapshot);
    expect(descriptions.get('Read')).toContain(exact);
  });

  it('clones only changed maps and entries and preserves snapshot metadata', () => {
    const schema = {
      type: 'object',
      properties: { pattern: { type: 'string' } },
    };
    const extra = { strict: true };
    const grep = {
      name: 'Grep',
      description: 'Native Grep.' + FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Grep[1],
      input_schema: schema,
      strict: true,
      extra,
    };
    const read = { name: 'Read', description: 'Read.', input_schema: {} };
    const record = { attachment: { tools: [grep], systemPrompt: ['stored'] } };
    const snapshot = {
      systemPrompt: ['stored'],
      toolDescriptions: new Map<string, unknown>([
        ['Read', 'Read.'],
        ['Grep', grep.description],
        ['Bash', 'Native Bash.'],
        ['Unknown', { value: 3 }],
      ]),
      toolEntries: new Map([
        ['Read', read],
        ['Grep', grep],
      ]),
      toolServers: new Map([['custom', 'server']]),
      snapshotHash: 'native hash',
      record,
    };
    const bytes = JSON.stringify(record);
    const normalized = clean(snapshot) as Snapshot;
    expect(normalized).not.toBe(snapshot);
    expect([...normalized.toolDescriptions!.keys()]).toEqual([
      ...snapshot.toolDescriptions.keys(),
    ]);
    expect([...normalized.toolEntries!.keys()]).toEqual([
      ...snapshot.toolEntries.keys(),
    ]);
    expect(normalized.toolEntries!.get('Read')).toBe(read);
    expect(normalized.toolEntries!.get('Grep')).toEqual({
      ...grep,
      description: 'Native Grep.',
    });
    expect(normalized.toolEntries!.get('Grep')?.input_schema).toBe(schema);
    expect(normalized.toolEntries!.get('Grep')?.extra).toBe(extra);
    expect(normalized.systemPrompt).toBe(snapshot.systemPrompt);
    expect(normalized.toolServers).toBe(snapshot.toolServers);
    expect(normalized.snapshotHash).toBe('native hash');
    expect(normalized.record).toBe(record);
    expect(JSON.stringify(record)).toBe(bytes);
  });

  it('retains untouched maps and missing fields', () => {
    const entries = new Map([
      ['Bash', { name: 'Bash', description: 'Native.', input_schema: {} }],
    ]);
    const descriptions = new Map([
      ['Bash', 'Native.' + FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Bash[0]],
    ]);
    const normalized = clean({
      toolDescriptions: descriptions,
      toolEntries: entries,
    }) as Snapshot;
    expect(normalized.toolEntries).toBe(entries);
    const withoutEntries = clean({
      toolDescriptions: descriptions,
    }) as Snapshot;
    expect(Object.hasOwn(withoutEntries, 'toolEntries')).toBe(false);
  });

  it.each([undefined, null, 3, 'snapshot', [], {}, { toolDescriptions: {} }])(
    'leaves unsupported snapshot data unchanged: %s',
    snapshot => {
      expect(clean(snapshot)).toBe(snapshot);
    }
  );

  it.each([undefined, null, 3, 'suffixes', {}])(
    'leaves data untouched with unsupported ownership data: %s',
    suffixes => {
      const snapshot = { toolDescriptions: new Map([['Bash', 'Native.']]) };
      expect(normalizeFffRecordedTools(snapshot, suffixes)).toBe(snapshot);
    }
  );
});

describe('fff hygiene native call sites', () => {
  it.each([
    ['2.1.296', PRISTINE, false],
    ['2.1.296', PRISTINE, true],
    ['2.1.299', PRISTINE_2_1_299, false],
    ['2.1.299', PRISTINE_2_1_299, true],
    ['2.1.314', PRISTINE_2_1_314, false],
    ['2.1.314', PRISTINE_2_1_314, true],
    ['2.1.322', PRISTINE_2_1_322, false],
    ['2.1.322', PRISTINE_2_1_322, true],
  ] as const)(
    'cleans resumed API/context maps without changing saved records, shape=%s, enabled=%s',
    async (_shape, pristine, enabled) => {
      const grep = {
        name: 'Grep',
        description: 'Native Grep.' + FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Grep[0],
        input_schema: { type: 'object' },
      };
      const record = { type: 'prompt_snapshot', tools: [grep] };
      const savedRoot =
        'old system prompt\n\n# Environment\n - \n - \n - \n\n# Context management\nKeep working.';
      const cleanedRoot =
        'old system prompt\n\n# Context management\nKeep working.';
      const snapshot: Snapshot = {
        systemPrompt: [
          savedRoot,
          '# Environment\n - \n - \n - ',
          ...FFF_OWNED_PROJECT_GUIDANCE,
        ],
        toolDescriptions: new Map([['Grep', grep.description]]),
        toolEntries: new Map([['Grep', grep]]),
        record,
        snapshotHash: 'unchanged hash',
      };
      const repaired = writeFffInstructionHygiene(pristine)!;
      expect(repaired).not.toBeNull();
      expect(writeFffInstructionHygiene(repaired)).toBe(repaired);
      const source = enabled ? writeFffInstructions(repaired)! : repaired;
      const fixture = evaluate(source);
      const result = await request(fixture, snapshot);
      const nativeText =
        result.request.options.recordedToolEntries.get('Grep')?.description ??
        result.request.options.recordedToolDescriptions.get('Grep') ??
        'fresh native description';
      expect(nativeText).toBe('Native Grep.');
      expect(
        result.request.options.recordedToolEntries.get('Grep')?.input_schema
      ).toBe(grep.input_schema);
      expect(result.request.systemPrompt).toEqual([cleanedRoot, 'environment']);
      expect(result.records).toEqual([record]);
      expect(result.records[0]).toBe(record);
      expect(record.tools[0]).toBe(grep);
      expect(grep.description).toContain(
        FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Grep[0]
      );
      const context = await fixture.$context(
        [snapshot],
        'model',
        {},
        TOOLS,
        [],
        {
          prompt: ['fresh custom override'],
          toolUseContext: { options: { tools: TOOLS } },
        }
      );
      expect(context.toolDescriptions?.get('Grep')).toBe('Native Grep.');
      expect(context.toolEntries?.get('Grep')?.description).toBe(
        'Native Grep.'
      );
      expect(context.snapshot).toBe(snapshot);
      expect(snapshot.systemPrompt).toEqual([
        savedRoot,
        '# Environment\n - \n - \n - ',
        ...FFF_OWNED_PROJECT_GUIDANCE,
      ]);
      expect(context.systemPrompt).toEqual([cleanedRoot]);
      expect(source).toContain('function __tweakccRecordedPrompt');
      expect(writeFffInstructionHygiene(source)).toBe(source);
    }
  );

  it.each([false, true])(
    'normalizes a saved Bash note once for API, context, and fork use, enabled=%s',
    async enabled => {
      const schema = { type: 'object' };
      const bash = {
        name: 'Bash',
        description: 'Saved Bash.\n\n' + FFF_BASH_GUIDANCE,
        input_schema: schema,
      };
      const snapshot: Snapshot = {
        systemPrompt: ['saved root', ...FFF_OWNED_PROJECT_GUIDANCE],
        toolDescriptions: new Map([['Bash', bash.description]]),
        toolEntries: new Map([['Bash', bash]]),
      };
      const repaired = writeFffInstructionHygiene(PRISTINE)!;
      const fixture = evaluate(
        enabled ? writeFffInstructions(repaired)! : repaired
      );
      const result = await request(fixture, snapshot);
      const context = await fixture.$context(
        [snapshot],
        'model',
        {},
        TOOLS,
        [],
        { prompt: ['live'], toolUseContext: { options: { tools: TOOLS } } }
      );
      const expected =
        'Saved Bash.' + (enabled ? '\n\n' + FFF_BASH_GUIDANCE : '');
      for (const maps of [
        {
          descriptions: result.request.options.recordedToolDescriptions,
          entries: result.request.options.recordedToolEntries,
        },
        {
          descriptions: context.toolDescriptions,
          entries: context.toolEntries,
        },
      ]) {
        const output = await fixture.$describe(
          {
            name: 'Bash',
            prompt: async () => 'Live Bash.',
            input_schema: schema,
          },
          {
            recordedDescription: maps.descriptions?.get('Bash'),
            recordedEntry: maps.entries?.get('Bash'),
          }
        );
        expect(output.description).toBe(expected);
        expect(output.input_schema).toBe(schema);
        const fork = await fixture.$describe(
          {
            name: 'Bash',
            prompt: async () => output.description,
            input_schema: schema,
          },
          { recordedEntry: output }
        );
        expect(fork.description).toBe(expected);
      }
      expect(result.request.systemPrompt).toEqual([
        'saved root',
        'environment',
      ]);
      expect(context.systemPrompt).toEqual(['saved root']);
      expect(snapshot.systemPrompt).toContain(FFF_OWNED_PROJECT_GUIDANCE[0]);
      expect(bash.description).toContain(FFF_BASH_GUIDANCE);
    }
  );

  it('covers direct restored entries rather than only description fallbacks', async () => {
    const snapshot: Snapshot = {
      systemPrompt: ['native'],
      toolEntries: new Map([
        [
          'Bash',
          {
            name: 'Bash',
            description:
              'Native Bash.' + FFF_OWNED_TOOL_GUIDANCE_SUFFIXES.Bash[2],
            input_schema: {},
          },
        ],
      ]),
    };
    const result = await request(
      evaluate(writeFffInstructionHygiene(PRISTINE)!),
      snapshot
    );
    expect(
      [...result.request.options.recordedToolEntries.values()].map(
        entry => entry.description
      )
    ).toEqual(['Native Bash.']);
    expect(result.request.snapshot.record).toBeUndefined();
    expect(snapshot.toolEntries?.get('Bash')?.description).toContain(
      'Native search and fff files:'
    );
  });

  it('scopes the 2.1.314 API selection to the hook-guarded query loop', () => {
    expect(PRISTINE_2_1_314).toContain('{reason:"hook_stopped"};if($state&&');
    const repaired = writeFffInstructionHygiene(PRISTINE_2_1_314)!;
    expect(repaired).not.toBeNull();
    const loop = repaired.indexOf('async function*$loop(){if($halted)');
    const site = repaired.indexOf(
      '$selected=(function __tweakccFffToolRecords'
    );
    expect(loop).toBeGreaterThan(-1);
    expect(site).toBeGreaterThan(loop);
    expect(repaired.indexOf('}yield*$loop()}')).toBeGreaterThan(site);
  });

  it('scopes the 2.1.322 context selection to the originalMessages context function', () => {
    expect(PRISTINE_2_1_322).not.toContain('mainThreadAgentDefinition:');
    const repaired = writeFffInstructionHygiene(PRISTINE_2_1_322)!;
    expect(repaired).not.toBeNull();
    const header = repaired.indexOf(
      'toolUseContext:$current,originalMessages:$original,'
    );
    const site = repaired.indexOf('$tools=(function __tweakccFffToolRecords(');
    const prompt = repaired.indexOf(
      '$counted=(function __tweakccRecordedPrompt('
    );
    const end = repaired.indexOf(
      'return{systemPrompt:$counted,toolDescriptions:$descriptions'
    );
    expect(header).toBeGreaterThan(-1);
    expect(site).toBeGreaterThan(header);
    expect(prompt).toBeGreaterThan(site);
    expect(end).toBeGreaterThan(prompt);
    expect(repaired).toContain(
      '$snapshot=$active($rows,$current.options),$tools=(function __tweakccFffToolRecords('
    );
    expect(writeFffInstructionHygiene(repaired)).toBe(repaired);
  });

  it('does nothing on pristine builds without native prompt snapshots', () => {
    const source = PRISTINE.replace(';var $type="prompt_snapshot";', '');
    expect(writeFffInstructionHygiene(source)).toBe(source);
    expect(writeFffInstructionHygiene('older native source')).toBe(
      'older native source'
    );
  });

  it.each([
    [
      'missing API prompt selection',
      PRISTINE.replace('$selected.systemPrompt', '$selected.otherPrompt'),
    ],
    [
      'missing context prompt selection',
      PRISTINE.replace('$snapshot?.systemPrompt', '$snapshot?.otherPrompt'),
    ],
    ['missing API selection', PRISTINE.replace(API_SITE, '')],
    ['missing context selection', PRISTINE.replace(CONTEXT_SITE, '$tools={}')],
    ['missing API scope', PRISTINE.replace(API, '')],
    ['missing context scope', PRISTINE.replace(CONTEXT, '')],
    ['duplicate API scope', PRISTINE + ';' + API],
    ['duplicate context scope', PRISTINE + CONTEXT],
    [
      'duplicate API selection',
      PRISTINE.replace(
        API_SITE,
        API_SITE +
          API_SITE.replaceAll('$selected', '$another')
            .replaceAll('$advisor', '$advisor2')
            .replaceAll('$deferred', '$deferred2')
            .replaceAll('$active', '$active2')
      ),
    ],
    [
      'duplicate context selection',
      PRISTINE.replace(
        CONTEXT_SITE,
        CONTEXT_SITE + ',' + CONTEXT_SITE.replaceAll('$tools', '$anotherTools')
      ),
    ],
    [
      'sibling API selection',
      PRISTINE.replace(API_SITE, '') + ';function sibling(){' + API_SITE + '}',
    ],
    [
      'nested API selection',
      PRISTINE.replace(API_SITE, 'function nested(){' + API_SITE + '}'),
    ],
    [
      'sibling context selection',
      PRISTINE.replace(CONTEXT_SITE, '$tools={}') +
        ';function sibling(){' +
        CONTEXT_SITE +
        '}',
    ],
    [
      'nested context selection',
      PRISTINE.replace(CONTEXT_SITE, '$tools={}').replace(
        'let $counted=',
        'function nested(){' + CONTEXT_SITE + '}let $counted='
      ),
    ],
  ])('rejects %s without modifying neighboring functions', (_, source) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(writeFffInstructionHygiene(source)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        'patch: fffInstructionHygiene: failed to find unique scoped recorded tool boundaries'
      );
    } finally {
      error.mockRestore();
    }
  });
});
