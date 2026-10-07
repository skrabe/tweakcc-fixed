// The stage-1 audit corpus: index, batched search, co-render hints, the
// verdict checker and the harvest, end to end on a small fixture corpus with a
// two-module virtual bundle shaped like CC 2.1.288's oversized-output builder.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openIndex,
  phraseSearch,
  termsSearch,
  neighbours,
  emitterSiblings,
  bestRelation,
  unescapeDeployed,
  reconstructPristine,
  parseOverrideFile,
  quoteIn,
} from './lib/auditCorpus.mjs';
import { checkGroup } from './checkAuditVerdicts.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));

const mod = (n, name, body) => `\n/*@@TWEAKCC_MODULE:${n}:${name}@@*/\n${body}`;
const BUNDLE =
  mod(
    0,
    'chunk-a.js',
    'function f(g){let ye=`first probe the structure carefully`,Te,xe;' +
      'if(g===void 0)Te=`Use jq to make structured queries now.`,xe=`- Note: this file is JSON single line ${ye}.`;' +
      'else Te=`Search within the file for specific content please.`;return Te+xe}'
  ) +
  mod(
    1,
    'chunk-b.js',
    'function h(){return "Another unrelated module text here."}'
  ) +
  mod(
    2,
    'chunk-c.js',
    'function k(){return "Err on the side of not "+"suggesting anything until you are sure. Then go."}'
  );

const P = (id, pieces, extra = {}) => ({
  id,
  name: id,
  description: `desc ${id}`,
  pieces,
  identifiers: [],
  identifierMap: {},
  version: '9.9.9',
  ...extra,
});
const CATALOGUE = {
  version: '9.9.9',
  prompts: [
    P('t-jq', ['Use jq to make structured queries now.']),
    P('t-note', ['- Note: this file is JSON single line ${', '}.'], {
      identifiers: [0],
      identifierMap: { 0: 'T_NOTE_VAR_0' },
    }),
    P('t-probe', ['first probe the structure carefully']),
    P('t-search', ['Search within the file for specific content please.']),
    P('t-other', ['Another unrelated module text here.']),
    P('t-shadowed', ['Shadowed prompt body text that is long.']),
    // Template-source escaping lives in the pieces; its synced stub is the
    // pieces verbatim, so it is pristine, not an override.
    P('t-esc', ['Pass the code inline via \\`script\\` and nothing else.']),
    // Two fragments of one sentence, joined by + in chunk-c.
    P('t-frag-a', ['Err on the side of not ']),
    P('t-frag-b', ['suggesting anything until you are sure. Then go.']),
    // A tool result and its own tool's description: same-tool.
    P('tool-result-memo-version-hint', [
      ' (pass the version token on your next write)',
    ]),
    P('tool-description-memo-rule', [
      'Every write needs the version token from the last read.',
    ]),
  ],
};

// The LCC CLAUDE.md the packet copies its decision-rule sections from.
const LCC_MD = [
  '# Working in this repo',
  '',
  '## What we are trying to achieve',
  '',
  '### The decision rule (read this every time)',
  '',
  'RULE-BODY-ONE: cut what is conveyed elsewhere.',
  '',
  '```bash',
  '# not a heading inside a fence',
  '```',
  '',
  '### Test for every cut',
  '',
  'RULE-BODY-LAST: would a fresh agent miss it?',
  '',
  '## Mandatory: re-read the guide',
  '',
  'NOT-IN-PACKET',
  '',
].join('\n');
const fm = (name, extra = '') =>
  `<!--\nname: ${name}\ndescription: d\nccVersion: 9.9.9\n${extra}-->\n`;

let dir;
let inputs;
beforeAll(() => {
  // The builder refuses to run without a turnProbe capture; these tests build
  // packets without one on purpose.
  process.env.TWEAKCC_NO_CAPTURE = '1';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-corpus-'));
  const set = path.join(dir, 'lcc', 'system-prompts-lcc');
  const rem = path.join(dir, 'lcc', 'system-reminders');
  fs.mkdirSync(set, { recursive: true });
  fs.mkdirSync(rem, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lcc', 'CLAUDE.md'), LCC_MD);
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(CATALOGUE));
  fs.writeFileSync(path.join(dir, 'cli.js'), BUNDLE);
  fs.writeFileSync(
    path.join(set, 't-jq.md'),
    fm('t-jq') + 'Use jq to make structured queries now.\n'
  );
  fs.writeFileSync(
    path.join(set, 't-note.md'),
    fm('t-note') + '- Note: this file is JSON single line ${T_NOTE_VAR_0}.\n'
  );
  fs.writeFileSync(
    path.join(set, 't-probe.md'),
    fm('t-probe') + 'first probe the \\`structure\\` carefully'
  );
  fs.writeFileSync(path.join(set, 't-search.md'), fm('t-search') + '\n');
  fs.writeFileSync(
    path.join(set, 't-shadowed.md'),
    fm('t-shadowed') + 'Shadowed prompt body text that is long.\n'
  );
  fs.writeFileSync(
    path.join(set, 't-esc.md'),
    fm('t-esc') + 'Pass the code inline via \\`script\\` and nothing else.\n'
  );
  fs.writeFileSync(
    path.join(set, 'inline-blob.md'),
    fm('blob', 'shadows:\n  - t-shadowed\n') +
      'Inline blob body for the shadowed prompt.\n'
  );
  fs.writeFileSync(
    path.join(rem, 'rem-a.md'),
    fm('rem') + 'Reminder body says jq is great for JSON.\n'
  );
  // TWEAKCC_CONFIG_DIR/system-prompts is how the builder resolves the active set.
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  fs.symlinkSync(set, path.join(cfg, 'system-prompts'));
  fs.symlinkSync(rem, path.join(cfg, 'system-reminders'));
  inputs = {
    catalogue: path.join(dir, 'prompts.json'),
    activeSet: fs.realpathSync(set),
    remindersDir: fs.realpathSync(rem),
    bundle: path.join(dir, 'cli.js'),
  };
});

const open = (extra = {}) =>
  openIndex({ ...inputs, cachePath: path.join(dir, 'idx.v8'), ...extra }).index;

describe('text helpers', () => {
  it('un-escapes template escapes in one pass', () => {
    expect(unescapeDeployed('a \\` b \\${X} c \\\\ d')).toBe(
      'a ` b ${X} c \\ d'
    );
  });
  it('reconstructs pristine with bare labels keyed by identifiers', () => {
    expect(reconstructPristine(CATALOGUE.prompts[1])).toBe(
      '- Note: this file is JSON single line ${T_NOTE_VAR_0}.'
    );
  });
  it('splits frontmatter and marks an empty body suppressed', () => {
    const r = parseOverrideFile(fm('x') + '\n');
    expect(r.suppressed).toBe(true);
    expect(r.frontmatter).toContain('name: x');
  });
  it('matches quotes exactly, across whitespace, and flags punctuation-only matches', () => {
    expect(quoteIn('Use jq\nnow.', 'Use jq now.')).toBe('whitespace');
    expect(quoteIn('Use jq now.', 'Use jq now.')).toBe('exact');
    expect(quoteIn('Use jq, now.', 'use jq now')).toBe('normalized-only');
    expect(quoteIn('Use jq now.', 'Use yq now.')).toBe(null);
  });
});

describe('corpus index', () => {
  it('covers overrides as deployed, pristine for ids without a file, inline blobs and reminders', () => {
    const index = open({ rebuild: true });
    const doc = id => index.docs[index.byId.get(id)];
    expect(doc('t-other').source).toBe('pristine');
    expect(doc('t-search').suppressed).toBe(true);
    expect(doc('t-probe').body).toBe('first probe the `structure` carefully');
    expect(doc('inline-blob').kind).toBe('inline');
    expect(doc('system-reminders/rem-a').kind).toBe('reminder');
    expect(doc('t-shadowed').shadowedBy).toEqual(['inline-blob']);
    expect(doc('t-esc').matchesPristine).toBe(true);
    expect(doc('t-esc').pristineBody).toBe(null);
    expect(doc('t-esc').body).toBe(
      'Pass the code inline via `script` and nothing else.'
    );
  });

  it('reuses the cache while the corpus is unchanged and rebuilds when it changes', () => {
    open();
    expect(
      openIndex({ ...inputs, cachePath: path.join(dir, 'idx.v8') }).cached
    ).toBe(true);
    const f = path.join(inputs.remindersDir, 'rem-b.md');
    fs.writeFileSync(f, fm('rem-b') + 'Another reminder.\n');
    try {
      const r = openIndex({ ...inputs, cachePath: path.join(dir, 'idx.v8') });
      expect(r.cached).toBe(false);
      expect(r.index.byId.has('system-reminders/rem-b')).toBe(true);
    } finally {
      fs.rmSync(f);
      open({ rebuild: true });
    }
  });
});

describe('co-render hints', () => {
  it('places siblings by branch relation inside the emitting function', () => {
    const index = open();
    const rel = c => bestRelation(index, 't-jq', index.byId.get(c)).relation;
    expect(rel('t-note')).toBe('same-branch');
    expect(rel('t-probe')).toBe('carrier-outside-target-branch');
    expect(rel('t-search')).toBe('exclusive-arms');
    expect(rel('t-other')).toBe('different-module');
    expect(rel('system-reminders/rem-a')).toBe('unresolved');
    expect(
      bestRelation(index, 't-probe', index.byId.get('t-jq')).relation
    ).toBe('carrier-conditional');
  });

  it('lists emitter siblings strongest relation first and never claims proof', () => {
    const index = open();
    const s = emitterSiblings(index, 't-jq');
    expect(s.siblings.map(x => x.id)).toEqual([
      't-note',
      't-probe',
      't-search',
    ]);
    expect(s.siblings.every(x => x.coRender.proven === false)).toBe(true);
  });
});

describe('batched search', () => {
  it('finds exact and normalized phrases, excluding the asking id', () => {
    const index = open();
    const r = phraseSearch(index, 'JSON single line', { forId: 't-jq' });
    expect(r.exact.hits.map(h => h.id)).toEqual(['t-note']);
    expect(r.exact.hits[0].rel).toBe('same-branch');
    const n = phraseSearch(index, 'json, SINGLE line', { forId: 't-jq' });
    expect(n.exact.total).toBe(0);
    expect(n.normalized.hits.map(h => h.id)).toEqual(['t-note']);
    expect(
      phraseSearch(index, 'structured queries', { forId: 't-jq' }).selfMatch
    ).toBe(true);
  });

  it('marks suppressed and pristine carriers on every hit', () => {
    const index = open();
    const r = phraseSearch(index, 'specific content', {});
    expect(r.exact.hits[0]).toMatchObject({ id: 't-search', suppressed: true });
    expect(
      phraseSearch(index, 'unrelated module', {}).exact.hits[0].pristine
    ).toBe(true);
  });

  it('bag-of-words needs all of up to three terms and most of a longer list', () => {
    const index = open();
    expect(
      termsSearch(index, ['jq', 'json'])
        .hits.map(h => h.id)
        .sort()
    ).toEqual(['system-reminders/rem-a']);
    const long = termsSearch(index, 'jq great json reminder banana');
    expect(long.need).toBe(3);
    expect(long.hits.map(h => h.id)).toContain('system-reminders/rem-a');
  });

  it('nearest neighbours come from the pristine body even when the target is suppressed', () => {
    const index = open();
    const n = neighbours(index, 't-search', { min: 0 });
    expect(Array.isArray(n)).toBe(true);
  });

  it('the CLI answers a whole batch in one call', () => {
    const packet = path.join(dir, 'p.json');
    fs.writeFileSync(
      packet,
      JSON.stringify({ corpus: { ...inputs, index: path.join(dir, 'idx.v8') } })
    );
    const q = path.join(dir, 'q.json');
    fs.writeFileSync(
      q,
      JSON.stringify({
        queries: [
          { forId: 't-jq', q: 'JSON single line' },
          { forId: 't-jq', q: ['probe', 'structure'] },
          { forId: 't-jq', q: 'zzz nothing here' },
        ],
        siblings: ['t-jq'],
        neighbours: ['t-jq'],
      })
    );
    const out = JSON.parse(
      execFileSync(
        'node',
        [
          path.join(TOOLS, 'auditCorpusSearch.mjs'),
          '--packet',
          packet,
          '--in',
          q,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
    );
    expect(out.results).toHaveLength(3);
    expect(out.results[0].exact.hits[0].id).toBe('t-note');
    expect(out.results[1].terms.hits[0].id).toBe('t-probe');
    expect(out.results[2].hits).toBe(0);
    expect(out.siblings['t-jq'][0]).toBe('t-note same-branch');
    expect(out.note).toMatch(/UNPROVEN/);
  });
});

describe('verdict checker', () => {
  const packet = ids => ({
    group: 'g00',
    prompts: ids.map(id =>
      typeof id === 'string' ? { id, externalRefs: {} } : id
    ),
  });
  const keep = id => ({
    id,
    verdict: 'pristine-keep',
    slopCheck: 's',
    duplicateCheck: 'd',
    why: 'w',
    coveredBy: [],
    trimPlan: null,
  });
  const wipe = (id, coveredBy) => ({
    ...keep(id),
    verdict: 'wipe-merge',
    coveredBy,
  });
  const check = (ids, verdicts) =>
    checkGroup({
      packet: packet(ids),
      verdictsText: JSON.stringify({ verdicts }),
      index: open(),
    });

  it('passes a complete, well-formed file', () => {
    const r = check(
      ['t-jq', 't-other'],
      [
        keep('t-jq'),
        wipe('t-other', [
          { carrierId: 't-note', quote: 'this file is JSON single line' },
        ]),
      ]
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('demands the exact id set and the schema', () => {
    const r = check(
      ['t-jq', 't-other'],
      [keep('t-jq'), keep('t-jq'), { ...keep('made-up'), extra: 1 }]
    );
    const text = r.errors.join('\n');
    expect(text).toMatch(/t-jq: duplicate verdict/);
    expect(text).toMatch(/made-up: not an id assigned/);
    expect(text).toMatch(/unexpected field\(s\): extra/);
    expect(text).toMatch(/t-other: no verdict/);
  });

  it('enforces trimPlan and coverage rules per verdict', () => {
    const r = check(
      [
        't-jq',
        't-other',
        { id: 't-probe', externalRefs: { rewriteReplacement: true } },
      ],
      [
        { ...keep('t-jq'), trimPlan: 'x' },
        { ...keep('t-other'), verdict: 'trim' },
        wipe('t-probe', [{ carrierId: 't-note', quote: 'JSON single line' }]),
      ]
    );
    const text = r.errors.join('\n');
    expect(text).toMatch(/t-jq: pristine-keep must have null trimPlan/);
    expect(text).toMatch(/t-other: trim needs a non-empty trimPlan/);
    expect(text).toMatch(/t-probe: externalRefs.rewriteReplacement/);
    expect(check(['t-jq'], [wipe('t-jq', [])]).errors.join()).toMatch(
      /at least one coveredBy/
    );
  });

  it('rejects carriers that cover nothing or quotes that are not there', () => {
    const r = check(
      ['t-jq'],
      [
        wipe('t-jq', [
          { carrierId: 't-search', quote: 'Search within' },
          { carrierId: 't-shadowed', quote: 'Shadowed prompt' },
          { carrierId: 'nope', quote: 'x' },
          { carrierId: 't-note', quote: 'json, SINGLE line' },
          { carrierId: 't-note', quote: 'never said this' },
          { carrierId: 't-jq', quote: 'Use jq' },
          { carrierId: 'carrier', quote: 'x', extra: 1 },
        ]),
      ]
    );
    const text = r.errors.join('\n');
    expect(text).toMatch(/t-search is SUPPRESSED/);
    expect(text).toMatch(/shadowed by inline-blob/);
    expect(text).toMatch(/"nope" is not in the corpus/);
    expect(text).toMatch(/only ignoring case\/punctuation/);
    expect(text).toMatch(/quote not found in the deployed body of t-note/);
    expect(text).toMatch(/cannot cover itself/);
    expect(text).toMatch(/unexpected field\(s\): extra/);
  });

  it('accepts MODEL_DEFAULT, reminder and inline carriers, and un-escaped quotes', () => {
    const r = check(
      ['t-jq'],
      [
        wipe('t-jq', [
          { carrierId: 'MODEL_DEFAULT', quote: 'the model already does this' },
          {
            carrierId: 'system-reminders/rem-a',
            quote: 'jq is great for JSON',
          },
          { carrierId: 'inline-blob', quote: 'Inline blob body' },
          { carrierId: 't-probe', quote: 'probe the `structure` carefully' },
        ]),
      ]
    );
    expect(r.errors).toEqual([]);
  });

  it('fails circular wipes and warns on alternative arms and trimmed carriers', () => {
    const circ = check(
      ['t-jq', 't-note'],
      [
        wipe('t-jq', [{ carrierId: 't-note', quote: 'JSON single line' }]),
        wipe('t-note', [{ carrierId: 't-probe', quote: 'first probe' }]),
      ]
    );
    expect(circ.errors.join()).toMatch(/itself wipe-merged in this file/);
    const arms = check(
      ['t-jq', 't-note'],
      [
        wipe('t-jq', [{ carrierId: 't-note', quote: 'JSON single line' }]),
        { ...keep('t-note'), verdict: 'trim', trimPlan: 'cut' },
      ]
    );
    expect(arms.ok).toBe(true);
    expect(arms.warnings.join()).toMatch(/also trimmed in this file/);
    const r = check(
      ['t-jq'],
      [
        {
          ...keep('t-jq'),
          verdict: 'trim',
          trimPlan: 'p',
          coveredBy: [
            { carrierId: 't-other', quote: 'Another unrelated module text' },
          ],
        },
      ]
    );
    expect(r.ok).toBe(true);
  });

  it('warns when the cited carrier sits on the other arm', () => {
    fs.writeFileSync(
      path.join(inputs.activeSet, 't-search.md'),
      fm('t-search') + 'Search within the file for specific content please.\n'
    );
    try {
      const index = open();
      const r = checkGroup({
        packet: packet(['t-jq']),
        verdictsText: JSON.stringify({
          verdicts: [
            wipe('t-jq', [
              { carrierId: 't-search', quote: 'Search within the file' },
            ]),
          ],
        }),
        index,
      });
      expect(r.ok).toBe(true);
      expect(r.warnings.join()).toMatch(/OTHER arm/);
    } finally {
      fs.writeFileSync(
        path.join(inputs.activeSet, 't-search.md'),
        fm('t-search') + '\n'
      );
      open({ rebuild: true });
    }
  });
});

describe('builder → checker → harvest', () => {
  it('builds lean packets, checks a group from the CLI, and harvests across groups', () => {
    const out = path.join(dir, 'packets');
    const idsFile = path.join(dir, 'ids.txt');
    fs.writeFileSync(idsFile, 't-jq\nt-note\nt-other\n');
    const env = {
      ...process.env,
      TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg'),
      TWEAKCC_CLI: inputs.bundle,
    };
    const log = execFileSync(
      'node',
      [
        path.join(TOOLS, 'buildAuditPacket.mjs'),
        inputs.catalogue,
        idsFile,
        out,
        '--ids-per-agent=2',
      ],
      { env, encoding: 'utf8' }
    );
    expect(log).toMatch(
      /workflow args: \{"version":"9.9.9","packetDir":".*","groupCount":2,/
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'audit-manifest.json'), 'utf8')
    );
    expect(manifest.groupCount).toBe(2);
    const packets = manifest.groups.map(g =>
      JSON.parse(fs.readFileSync(g.packet, 'utf8'))
    );
    const all = packets.flatMap(p => p.prompts);
    const jq = all.find(p => p.id === 't-jq');
    expect(jq.setFiles[0].deployed).toBe('pristine');
    expect(jq.setFiles[0].body).toBeUndefined();
    expect(jq.emitterSiblings[0]).toBe('t-note same-branch');
    expect(all.find(p => p.id === 't-other').setFiles[0].deployed).toBe(
      'absent'
    );
    expect(all.find(p => p.id === 't-note').pristineBodies).toEqual([
      '- Note: this file is JSON single line ${T_NOTE_VAR_0}.',
    ]);
    const meta = JSON.parse(
      fs.readFileSync(path.join(out, 'audit-meta.json'), 'utf8')
    );
    expect(meta['t-jq'].sets['system-prompts-lcc']).toContain('name: t-jq');
    expect(JSON.stringify(packets)).not.toContain('<!--');

    const harvest = () =>
      spawnSync('node', [path.join(TOOLS, 'harvestAudit.mjs'), out], {
        encoding: 'utf8',
      });
    let h = harvest();
    expect(h.status).toBe(1);
    expect(h.stdout).toMatch(/rerun groups: g00, g01/);

    const keep = id => ({
      id,
      verdict: 'pristine-keep',
      slopCheck: 's',
      duplicateCheck: 'd',
      why: 'w',
      coveredBy: [],
      trimPlan: null,
    });
    for (const g of manifest.groups) {
      const vs = g.ids.map(id =>
        id === 't-other'
          ? {
              ...keep(id),
              verdict: 'wipe-merge',
              coveredBy: [{ carrierId: 't-note', quote: 'JSON single line' }],
            }
          : keep(id)
      );
      fs.writeFileSync(g.verdicts, JSON.stringify({ verdicts: vs }));
      const c = spawnSync(
        'node',
        [path.join(TOOLS, 'checkAuditVerdicts.mjs'), g.packet, g.verdicts],
        { encoding: 'utf8' }
      );
      expect(c.stdout).toMatch(
        new RegExp(`^PASS ${g.name} (\\d+)/\\1 verdicts sha256=[0-9a-f]{12}`)
      );
    }
    h = harvest();
    expect(h.status).toBe(0);
    const result = JSON.parse(
      fs.readFileSync(path.join(out, 'stage1-result.json'), 'utf8')
    );
    expect(result.verdicts.map(v => v.id)).toEqual([
      't-jq',
      't-note',
      't-other',
    ]);
    expect(result.counts).toEqual({
      'pristine-keep': 2,
      trim: 0,
      'wipe-merge': 1,
    });

    // A carrier wiped by ANOTHER group is circular coverage.
    const gNote = manifest.groups.find(g => g.ids.includes('t-note'));
    const gOther = manifest.groups.find(g => g.ids.includes('t-other'));
    if (gNote !== gOther) {
      const vs = JSON.parse(fs.readFileSync(gNote.verdicts, 'utf8'));
      vs.verdicts = vs.verdicts.map(v =>
        v.id === 't-note'
          ? {
              ...v,
              verdict: 'wipe-merge',
              coveredBy: [{ carrierId: 't-probe', quote: 'first probe' }],
            }
          : v
      );
      fs.writeFileSync(gNote.verdicts, JSON.stringify(vs));
      h = harvest();
      expect(h.status).toBe(1);
      expect(h.stdout).toMatch(/circular coverage/);
    }

    // The freeze: an edit after the build is reported.
    fs.appendFileSync(path.join(inputs.activeSet, 't-jq.md'), 'x\n');
    try {
      expect(harvest().stdout).toMatch(
        /corpus changed after the packets were built/
      );
    } finally {
      fs.writeFileSync(
        path.join(inputs.activeSet, 't-jq.md'),
        fm('t-jq') + 'Use jq to make structured queries now.\n'
      );
    }
  });
});

describe('builder deployed label', () => {
  it('labels a synced stub with template escapes pristine, and a real edit override', () => {
    const run = (ids, out) => {
      const idsFile = path.join(dir, `${out}.txt`);
      fs.writeFileSync(idsFile, ids.join('\n') + '\n');
      execFileSync(
        'node',
        [
          path.join(TOOLS, 'buildAuditPacket.mjs'),
          inputs.catalogue,
          idsFile,
          path.join(dir, out),
          '--ids-per-agent=5',
        ],
        {
          env: { ...process.env, TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg') },
          encoding: 'utf8',
        }
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, out, 'audit-manifest.json'), 'utf8')
      );
      return manifest.groups
        .flatMap(g => JSON.parse(fs.readFileSync(g.packet, 'utf8')).prompts)
        .reduce((m, p) => ({ ...m, [p.id]: p.setFiles[0] }), {});
    };
    const rows = run(['t-esc', 't-probe'], 'packets-esc');
    expect(rows['t-esc'].deployed).toBe('pristine');
    expect(rows['t-esc'].body).toBeUndefined();
    expect(rows['t-probe'].deployed).toBe('override');
    expect(rows['t-probe'].body).toBe(
      'first probe the \\`structure\\` carefully'
    );
  });
});

describe('markdown packet', () => {
  const build = (ids, out, perAgent = 100, extraEnv = {}) => {
    const idsFile = path.join(dir, `${out}.txt`);
    fs.writeFileSync(idsFile, ids.join('\n') + '\n');
    const log = execFileSync(
      'node',
      [
        path.join(TOOLS, 'buildAuditPacket.mjs'),
        inputs.catalogue,
        idsFile,
        path.join(dir, out),
        `--ids-per-agent=${perAgent}`,
      ],
      {
        env: {
          ...process.env,
          TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg'),
          TWEAKCC_CLI: inputs.bundle,
          ...extraEnv,
        },
        encoding: 'utf8',
      }
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, out, 'audit-manifest.json'), 'utf8')
    );
    return {
      log,
      manifest,
      md: manifest.groups.map(g => fs.readFileSync(g.md, 'utf8')),
      json: manifest.groups.map(g =>
        JSON.parse(fs.readFileSync(g.packet, 'utf8'))
      ),
    };
  };
  const IDS = [
    't-jq',
    't-note',
    't-other',
    't-frag-a',
    't-frag-b',
    'tool-result-memo-version-hint',
  ];

  it('carries the rules, every id and full body, and each carrier once', () => {
    const { md, json } = build(IDS, 'md-one');
    expect(md).toHaveLength(1);
    const text = md[0];
    expect(text).toContain('RULE-BODY-ONE');
    expect(text).toContain('# not a heading inside a fence');
    expect(text).toContain('RULE-BODY-LAST');
    expect(text).not.toContain('NOT-IN-PACKET');
    for (const p of json[0].prompts) {
      expect(text).toContain(`\`${p.id}\``);
      for (const b of p.pristineBodies) expect(text).toContain(b);
    }
    // t-probe is a lead of both t-jq and t-note; its body is rendered once.
    expect(text.split('### `t-probe`').length - 1).toBe(1);
    expect(text).toContain('first probe the `structure` carefully');
    // The precomputed search found t-note's sentence for t-jq's neighbours.
    expect(text).toMatch(/Corpus search \(precomputed/);
    expect(text).toContain('bundleQuery.mjs --cli');
    expect(text).toContain('writeAuditVerdicts.mjs');
    expect(json[0].md).toMatch(/audit-packet-00\.md$/);
    expect(json[0].commands.write).toContain('writeAuditVerdicts.mjs');
  });

  it('lists concatenated fragments and the tool a result belongs to', () => {
    const { md, json } = build(IDS, 'md-concat');
    const a = json[0].prompts.find(p => p.id === 't-frag-a');
    expect(a.concatNeighbours).toEqual([
      expect.objectContaining({
        side: 'after',
        how: '+',
        id: 't-frag-b',
        crossesSentence: true,
        pristine: 'suggesting anything until you are sure. Then go.',
      }),
    ]);
    expect(md[0]).toContain('a sentence CROSSES this boundary');
    expect(md[0]).toContain('`tool-description-memo-rule` · same-tool');
    expect(md[0]).toContain('same-tool: PROVABLE co-render');
    const index = open();
    expect(
      bestRelation(
        index,
        'tool-result-memo-version-hint',
        index.byId.get('tool-description-memo-rule')
      ).relation
    ).toBe('same-tool');
  });

  it('cuts ceil(ids / ids-per-agent) groups in input order', () => {
    const { md, manifest, log } = build(IDS, 'md-size-2', 2);
    expect(manifest.groups).toHaveLength(3);
    expect(md).toHaveLength(3);
    expect(manifest.groups.flatMap(g => g.ids)).toEqual(IDS);
    expect(manifest.packing).toMatchObject({ idsPerAgent: 2, agents: 3 });
    expect(log).toMatch(/md sizes min \d+/);
    expect(log).toMatch(/"mdParts":\[1,1,1\]/);
  });

  it('splits a packet larger than one Read into parts and lists them', () => {
    // A 1,000-token Read cap makes every packet here span several parts.
    const { md, manifest, json } = build(IDS, 'md-parts', 100, {
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '1000',
    });
    const g = manifest.groups[0];
    expect(g.mdParts.length).toBeGreaterThan(1);
    expect(json[0].mdParts).toEqual(g.mdParts);
    const parts = g.mdParts.map(f => fs.readFileSync(f, 'utf8'));
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(1650);
    const body = parts.map(p => p.split('\n').slice(1).join('\n')).join('\n');
    for (const p of json[0].prompts) expect(body).toContain(`\`${p.id}\``);
    expect(md[0].length).toBeGreaterThan(0);
  });

  it('hunts every stage-1 keep in ceil(keeps / ids-per-agent) groups, leads as evidence', () => {
    build(IDS, 'hunt-src');
    const src = path.join(dir, 'hunt-src');
    const verdicts = IDS.map((id, i) => ({
      id,
      verdict: i === 0 ? 'trim' : 'pristine-keep',
      slopCheck: 's',
      duplicateCheck: 'd',
      why: 'w',
      coveredBy: [],
      trimPlan: i === 0 ? 'cut' : null,
    }));
    fs.writeFileSync(
      path.join(src, 'stage1-result.json'),
      JSON.stringify({ complete: true, verdicts })
    );
    const huntDir = path.join(dir, 'hunt');
    const log = execFileSync(
      'node',
      [path.join(TOOLS, 'selectCutHunt.mjs'), src, huntDir, '--ids-per-agent', '2'],
      { env: { ...process.env, TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg') }, encoding: 'utf8' }
    );
    const hm = JSON.parse(
      fs.readFileSync(path.join(huntDir, 'hunt-manifest.json'), 'utf8')
    );
    expect(hm.groups.flatMap(g => g.ids)).toEqual(IDS.slice(1));
    expect(hm.groupCount).toBe(3);
    expect(hm.selected).toBe(IDS.length - 1);
    const args = JSON.parse(log.trim().split('\n').pop().replace(/^workflow args: /, ''));
    expect(args).toMatchObject({ groupCount: 3, mdParts: [1, 1, 1] });
    for (const g of hm.groups) expect(fs.readFileSync(g.md, 'utf8')).toContain('**Cut leads:**');
    const r = spawnSync(
      'node',
      [path.join(TOOLS, 'selectCutHunt.mjs'), src, huntDir, '--share', '0.25'],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/every stage-1 keep is hunted/);
  });

  it('refuses to build without a turnProbe capture unless opted out', () => {
    const idsFile = path.join(dir, 'nocap.txt');
    fs.writeFileSync(idsFile, 't-jq\n');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-captures-'));
    const run = (extra, env = {}) =>
      spawnSync(
        'node',
        [
          path.join(TOOLS, 'buildAuditPacket.mjs'),
          inputs.catalogue,
          idsFile,
          path.join(dir, 'nocap-out'),
          ...extra,
        ],
        {
          env: {
            ...process.env,
            TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg'),
            TWEAKCC_NO_CAPTURE: '',
            TWEAKCC_CAPTURES: tmp,
            ...env,
          },
          encoding: 'utf8',
        }
      );
    const refused = run([]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/TWEAKCC_CAPTURES/);
    expect(refused.stderr).toMatch(/driver check/);
    expect(fs.existsSync(path.join(dir, 'nocap-out', 'audit-manifest.json'))).toBe(false);
    for (const [extra, env] of [[['--no-capture'], {}], [[], { TWEAKCC_NO_CAPTURE: '1' }]]) {
      const ok = run(extra, env);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/NO turnProbe capture/);
      const man = JSON.parse(
        fs.readFileSync(path.join(dir, 'nocap-out', 'audit-manifest.json'), 'utf8')
      );
      expect(man.capture).toBeNull();
    }
  });

  it('refuses the retired size knobs', () => {
    const idsFile = path.join(dir, 'retired.txt');
    fs.writeFileSync(idsFile, 't-jq\n');
    const r = spawnSync(
      'node',
      [path.join(TOOLS, 'buildAuditPacket.mjs'), inputs.catalogue, idsFile, path.join(dir, 'retired'), '14'],
      { env: { ...process.env, TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg'), TWEAKCC_CLI: inputs.bundle }, encoding: 'utf8' }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--ids-per-agent/);
  });

  it('fails loudly when the LCC decision-rule headings are missing', () => {
    const f = path.join(dir, 'lcc', 'CLAUDE.md');
    fs.writeFileSync(f, '# nothing here\n');
    try {
      const r = spawnSync(
        'node',
        [
          path.join(TOOLS, 'buildAuditPacket.mjs'),
          inputs.catalogue,
          path.join(dir, 'md-one.txt'),
          path.join(dir, 'md-broken'),
        ],
        {
          env: { ...process.env, TWEAKCC_CONFIG_DIR: path.join(dir, 'cfg') },
          encoding: 'utf8',
        }
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/decision-rule sections/);
    } finally {
      fs.writeFileSync(f, LCC_MD);
    }
  });

  it('holds a fragment trim to the sentence it shares with its neighbour', () => {
    const { json } = build(IDS, 'md-check', 200000);
    const packet = json[0];
    const keep = id => ({
      id,
      verdict: 'pristine-keep',
      slopCheck: 's',
      duplicateCheck: 'd',
      why: 'w',
      coveredBy: [],
      trimPlan: null,
    });
    const vs = trimPlan =>
      JSON.stringify({
        verdicts: packet.prompts.map(p =>
          p.id === 't-frag-a'
            ? { ...keep(p.id), verdict: 'trim', trimPlan }
            : keep(p.id)
        ),
      });
    const bad = checkGroup({
      packet,
      verdictsText: vs('drop it'),
      index: open(),
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/concatenated fragment t-frag-b/);
    const good = checkGroup({
      packet,
      verdictsText: vs(
        'remove the sentence whole: also cut its tail in t-frag-b'
      ),
      index: open(),
    });
    expect(good.ok).toBe(true);
    // Its neighbour is kept pristine in the same file: the trim is warned,
    // a wipe (which certainly breaks the sentence) fails.
    expect(good.warnings.join('\n')).toMatch(
      /continues in concatenated fragment t-frag-b \(after\), which is pristine-keep/
    );
    const wipe = checkGroup({
      packet,
      verdictsText: JSON.stringify({
        verdicts: packet.prompts.map(p =>
          p.id === 't-frag-a'
            ? {
                ...keep(p.id),
                verdict: 'wipe-merge',
                why: 'covered; t-frag-b keeps its half',
                coveredBy: [{ carrierId: 't-note', quote: 'JSON single line' }],
              }
            : keep(p.id)
        ),
      }),
      index: open(),
    });
    expect(wipe.ok).toBe(false);
    expect(wipe.errors.join('\n')).toMatch(/would be left broken/);
  });

  it('writes and checks in one step, merges fixes, and refuses bad input', () => {
    const { manifest } = build(['t-jq', 't-other'], 'md-write', 200000);
    const g = manifest.groups[0];
    const w = (input, extra = []) =>
      spawnSync(
        'node',
        [path.join(TOOLS, 'writeAuditVerdicts.mjs'), g.packet, ...extra],
        { input, encoding: 'utf8' }
      );
    const keep = id => ({
      id,
      verdict: 'pristine-keep',
      slopCheck: 's',
      duplicateCheck: 'd',
      why: 'w',
      coveredBy: [],
      trimPlan: null,
    });
    let r = w('{not json');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^FAIL g00: stdin is not valid JSON/);
    expect(fs.existsSync(g.verdicts)).toBe(false);
    r = w(JSON.stringify({ verdicts: [keep('t-jq')] }));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^FAIL g00/);
    expect(r.stdout).toContain('t-other: no verdict');
    r = w(JSON.stringify({ verdicts: [keep('t-other')] }), ['--merge']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^PASS g00 (\d+)\/\1 verdicts sha256=[0-9a-f]{12}/
    );
    const onDisk = JSON.parse(fs.readFileSync(g.verdicts, 'utf8'));
    expect(onDisk.verdicts.map(v => v.id)).toEqual(['t-jq', 't-other']);
    const c = spawnSync(
      'node',
      [path.join(TOOLS, 'checkAuditVerdicts.mjs'), g.packet, g.verdicts],
      { encoding: 'utf8' }
    );
    expect(c.stdout.split('\n')[0]).toBe(r.stdout.split('\n')[0]);
  });

  it('the search CLI prints its results as text', () => {
    const { manifest } = build(['t-jq'], 'md-search', 200000);
    const g = manifest.groups[0];
    const q = path.join(dir, 'md-search', 'search-00.json');
    fs.writeFileSync(
      q,
      JSON.stringify({ queries: [{ forId: 't-jq', q: 'JSON single line' }] })
    );
    const out = execFileSync(
      'node',
      [
        path.join(TOOLS, 'auditCorpusSearch.mjs'),
        '--packet',
        g.packet,
        '--in',
        q,
        '--out',
        path.join(dir, 'md-search', 'search-00.out.json'),
        '--text',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    expect(out).toMatch(/q0 \[t-jq\] "JSON single line"/);
    expect(out).toMatch(/- t-note \[same-branch\]/);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(dir, 'md-search', 'search-00.out.json'),
          'utf8'
        )
      ).results
    ).toHaveLength(1);
  });
});
