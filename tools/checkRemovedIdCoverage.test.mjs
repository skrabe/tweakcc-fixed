// Locks the removed-id gate against the miss found on CC 2.1.261: a prompt made
// almost entirely of `${…}` slots has no literal run long enough for the 25-char
// window, so every probe pass came back empty and the id fell through to
// `gone` — which tells the operator to archive an override that is still live.
// Two real prompts hit it that bump (`Published ${.path)} at ${.url)}${}…` and
// the computer-use background-element result), and both were sitting in the
// classify sidecar at the time.
//
// The tool is a script, not a module: it does its work at import time. So this
// drives it as a subprocess against fixtures, which is also the only way to
// assert the bucketing the pipeline actually reads.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(
  new URL('./checkRemovedIdCoverage.mjs', import.meta.url)
);
let dir;

const write = (name, value) => {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
  return p;
};

// TWEAKCC_CLASSIFY_DIR points the sidecar scan at an empty directory: reading
// the real /tmp would let whatever bump is in flight decide the answer.
const run = (cli, prev, cur, allowlist, cache) => {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      TWEAKCC_CLASSIFY_DIR: path.join(dir, 'empty'),
      TWEAKCC_RENAME_MAP: path.join(dir, 'renames.json'),
      ...(allowlist && { TWEAKCC_REMOVED_ID_ALLOWLIST: allowlist }),
      ...(cache && { TWEAKCC_CLASSIFICATION_CACHE: cache }),
    },
  };
  try {
    return execFileSync(process.execPath, [TOOL, cli, prev, cur], opts);
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

// The slot-only shape, from CC 2.1.259's `tool-result-artifact-published`.
const slotOnly = {
  id: 'tool-result-artifact-published',
  version: '2.1.259',
  pieces: ['Published ${', '(', '.path)} at ${', '(', '.url)}${', '}'],
  identifiers: [0, 1, 2, 1, 3],
  identifierMap: { 0: 'VAR_0', 1: 'VAR_1', 2: 'VAR_2', 3: 'VAR_3' },
};

// A real removal: long, distinctive prose that is nowhere in the bundle.
const realRemoval = {
  // A synthetic id: a REAL one gets an `archived` verdict in
  // data/removed-id-allowlist.json the moment that removal is processed, and
  // the gate then correctly stops listing it — which fails this test for the
  // opposite of the reason it exists.
  id: 'tool-result-fixture-genuinely-absent',
  version: '2.1.259',
  pieces: [
    'A sub-goal is the smallest unit of work that is worth narrating on its ' +
      'own, and it ends when every tool call it required has returned.',
  ],
  identifiers: [],
  identifierMap: {},
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-id-'));
  fs.mkdirSync(path.join(dir, 'empty'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('checkRemovedIdCoverage: prompts with little literal text', () => {
  it('does not call a slot-only prompt removed while its text is in the bundle', () => {
    const out = run(
      write(
        'cli.js',
        'function q(e){return `Published ${a(e.path)} at ${a(e.url)}${b}`}'
      ),
      write('prev.json', { prompts: [slotOnly] }),
      write('cur.json', { prompts: [] })
    );
    expect(out).toMatch(/STILL IN BUNDLE[\s\S]*tool-result-artifact-published/);
    expect(out).not.toMatch(
      /truly removed, no recorded verdict:[\s\S]*tool-result-artifact-published/
    );
  });

  it('ignores a piece carrying a minified bracket key, which changes per build', () => {
    // `[_.kind]` on one build is `[k.kind]` on the next, so requiring it makes
    // a live prompt read as removed — the computer-use case on CC 2.1.261.
    const prompt = {
      id: 'tool-result-computer-use-element',
      version: '2.1.259',
      pieces: ['This element (${', '}) cannot be ${', '[_.kind]} while ${', ')} is in the '],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'A', 1: 'B', 2: 'C' },
    };
    const out = run(
      write(
        'cli-bk.js',
        'x=`This element (${a}) cannot be ${L[k.kind]} while ${f(b)} is in the ${s}`'
      ),
      write('prev-bk.json', { prompts: [prompt] }),
      write('cur-bk.json', { prompts: [] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*tool-result-computer-use-element/
    );
  });

  it('still calls a genuinely absent prompt removed', () => {
    const out = run(
      write('cli-gone.js', 'function q(){return "unrelated bundle text"}'),
      write('prev-gone.json', { prompts: [realRemoval] }),
      write('cur-gone.json', { prompts: [] })
    );
    expect(out).toMatch(
      /truly removed[\s\S]*tool-result-fixture-genuinely-absent/
    );
  });

  it('stops counting a removal as needing a decision once it is archived', () => {
    const cli = write('cli-gone2.js', 'function q(){return "unrelated"}');
    const prev = write('prev-gone2.json', { prompts: [realRemoval] });
    const cur = write('cur-gone2.json', { prompts: [] });
    expect(run(cli, prev, cur)).toMatch(/1 truly removed \(1 need a decision\)/);
    const allow = write('allow-gone2.json', {
      'tool-result-fixture-genuinely-absent': { verdict: 'archived' },
    });
    expect(run(cli, prev, cur, allow)).toMatch(
      /1 truly removed \(0 need a decision\)/
    );
  });

  it('reports no-probe-surface rather than a removal when it cannot test either way', () => {
    const out = run(
      write('cli-np.js', 'function q(){return "x"}'),
      write('prev-np.json', {
        prompts: [
          {
            id: 'tool-result-slotless',
            version: '2.1.259',
            pieces: ['${', '}${', '}'],
            identifiers: [0, 1],
            identifierMap: { 0: 'A', 1: 'B' },
          },
        ],
      }),
      write('cur-np.json', { prompts: [] })
    );
    expect(out).toMatch(/no probe surface/);
    expect(out).toMatch(/NO PROBE SURFACE[\s\S]*tool-result-slotless/);
    expect(out).not.toMatch(
      /truly removed, no recorded verdict:[\s\S]*tool-result-slotless/
    );
  });

  it('settles a no-probe id once an archived verdict records the hand review', () => {
    const slotless = {
      id: 'tool-result-fixture-slotless-archived',
      version: '2.1.259',
      pieces: ['${', '}${', '}'],
      identifiers: [0, 1],
      identifierMap: { 0: 'A', 1: 'B' },
    };
    const allow = write('allow-np.json', {
      'tool-result-fixture-slotless-archived': { verdict: 'archived' },
    });
    const out = run(
      write('cli-np2.js', 'function q(){return "x"}'),
      write('prev-np2.json', { prompts: [slotless] }),
      write('cur-np2.json', { prompts: [] }),
      allow
    );
    expect(out).toMatch(/0 no probe surface/);
    expect(out).toMatch(
      /resolved by hand \(archived\): tool-result-fixture-slotless-archived/
    );
  });
});

// A shipped id later ruled ui/internal keeps its text in the bundle, so without
// a resolution it reads as IN-BUNDLE on every run after the correction.
describe('checkRemovedIdCoverage: ids ruled non-model by a catalogue correction', () => {
  const ruledUi = {
    id: 'slash-command-fixture-ruled-ui',
    version: '2.1.288',
    pieces: [
      'The data folder of this plugin was kept because another installed plugin still uses it.',
    ],
    identifiers: [],
    identifierMap: {},
  };
  const hash = 'a'.repeat(40);
  const bundle =
    'x="The data folder of this plugin was kept because another installed plugin still uses it."';

  it('settles an IN-BUNDLE id whose archived row matches the cached verdict', () => {
    const out = run(
      write('cli-ui.js', bundle),
      write('prev-ui.json', { prompts: [ruledUi] }),
      write('cur-ui.json', { prompts: [] }),
      write('allow-ui.json', {
        'slash-command-fixture-ruled-ui': { verdict: 'archived', facing: 'ui', hash },
      }),
      write('cache-ui.json', { [hash]: { facing: 'ui' } })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE, 1 ruled non-model/);
    expect(out).toMatch(/removed-id coverage: PASS/);
  });

  it('keeps failing when the cache no longer holds the non-model verdict', () => {
    const out = run(
      write('cli-ui2.js', bundle),
      write('prev-ui2.json', { prompts: [ruledUi] }),
      write('cur-ui2.json', { prompts: [] }),
      write('allow-ui2.json', {
        'slash-command-fixture-ruled-ui': { verdict: 'archived', facing: 'ui', hash },
      }),
      write('cache-ui2.json', { [hash]: { facing: 'model', id: 'x' } })
    );
    expect(out).toMatch(/CACHE DISAGREES[\s\S]*slash-command-fixture-ruled-ui/);
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });
});

// CC 2.1.294: one ternary emits two tails that share their opening clause. The
// resume-only arm lost its id, its first 25-char window matched the relaunch
// arm, and the gate called it renamed to the sibling and passed.
describe('checkRemovedIdCoverage: a rename needs most of the old body', () => {
  const tpl = (verb, tail) => ({
    pieces: [
      ' ${',
      '.length===1?"Agent":"Agents"} ${',
      `.join(", ")} fetched web content and \${`,
      `.length===1?"has":"have"} ${verb} \${`,
      `.length===1?"it":"them"} ${tail}`,
    ],
    identifiers: [0, 0, 0, 0],
    identifierMap: { 0: 'AGENTS' },
    version: '2.1.292',
  });
  const resumeOnly = {
    id: 'tool-result-fixture-webfetch-resume-only-tail',
    ...tpl(
      'no worktree or output to check — resume',
      'with SendMessage only.'
    ),
  };
  const relaunch = {
    id: 'tool-result-fixture-webfetch-relaunch-tail',
    ...tpl('nothing to check — launch', 'again if still needed.'),
  };
  const bundle =
    'k=w?` ${g.length===1?"Agent":"Agents"} ${g.join(", ")} fetched web content and ' +
    '${g.length===1?"has":"have"} no worktree or output to check \\u2014 resume ' +
    '${g.length===1?"it":"them"} with ${nr} only.`:` ${g.length===1?"Agent":"Agents"} ' +
    '${g.join(", ")} fetched web content and ${g.length===1?"has":"have"} nothing to ' +
    'check \\u2014 launch ${g.length===1?"it":"them"} again if still needed.`';

  it('does not call an id renamed to a sibling that shares only its opening', () => {
    const out = run(
      write('cli-sib.js', bundle),
      write('prev-sib.json', { prompts: [resumeOnly, relaunch] }),
      write('cur-sib.json', { prompts: [relaunch] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*tool-result-fixture-webfetch-resume-only-tail/
    );
    expect(out).toMatch(/0 renamed\/reshuffled/);
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  it('follows a rename whose literal became a slot', () => {
    const old = {
      id: 'tool-result-fixture-resume-for-report',
      version: '2.1.292',
      pieces: [
        'Resume it by sending it a message with SendMessage to get its report.',
      ],
      identifiers: [],
      identifierMap: {},
    };
    const successor = {
      id: 'tool-result-fixture-resume-for-report-slotted',
      version: '2.1.294',
      pieces: ['Resume it by sending it a message with ${', '} to get its report.'],
      identifiers: [0],
      identifierMap: { 0: 'SEND_TOOL' },
    };
    const out = run(
      write(
        'cli-slot.js',
        'x=`Resume it by sending it a message with ${nr} to get its report.`'
      ),
      write('prev-slot.json', { prompts: [old] }),
      write('cur-slot.json', { prompts: [successor] })
    );
    expect(out).toMatch(/1 renamed\/reshuffled/);
    expect(out).toMatch(/removed-id coverage: PASS/);
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'renames.json'), 'utf8'));
    expect(map['tool-result-fixture-resume-for-report']).toBe(
      'tool-result-fixture-resume-for-report-slotted'
    );
  });

  it('reports text the successor carries but the bundle also holds at an uncovered site', () => {
    const text =
      'The background shell was stopped before it finished, so read its output file before relying on it.';
    const old = {
      id: 'tool-result-fixture-shell-stopped-read-output',
      version: '2.1.292',
      pieces: [text],
      identifiers: [],
      identifierMap: {},
    };
    const successor = {
      id: 'tool-result-fixture-shell-stopped-read-output-renamed',
      version: '2.1.294',
      pieces: [text],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write('cli-stray.js', `a="${text}";b=\`${text}\``),
      write('prev-stray.json', { prompts: [old] }),
      write('cur-stray.json', { prompts: [successor] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*tool-result-fixture-shell-stopped-read-output {2}\(text also at a site tool-result-fixture-shell-stopped-read-output-renamed does not cover/
    );
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  it('calls a reworded removal removed even when a live id shares a few phrases', () => {
    const old = {
      id: 'tool-result-fixture-timers-reschedule',
      version: '2.1.292',
      pieces: [
        'Schedule each one again if it is still needed, with the prompt of your earlier call; do the work of an overdue one now.',
      ],
      identifiers: [],
      identifierMap: {},
    };
    const live = {
      id: 'tool-result-fixture-container-timers-lost',
      version: '2.1.294',
      pieces: [
        'The container was restarted, so these timers will not fire. Schedule each again if still needed (do the work of an overdue one now).',
      ],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write(
        'cli-reword.js',
        'x="The container was restarted, so these timers will not fire. Schedule each again if still needed (do the work of an overdue one now)."'
      ),
      write('prev-reword.json', { prompts: [old, live] }),
      write('cur-reword.json', { prompts: [live] })
    );
    expect(out).toMatch(/0 renamed\/reshuffled/);
    expect(out).toMatch(
      /truly removed, no recorded verdict:\s+tool-result-fixture-timers-reschedule {2}\(closest current id: tool-result-fixture-container-timers-lost/
    );
  });
});

// CC 2.1.295: the tail window of a removed clause (` Claude Code configuratio`)
// also sits in an unrelated admin-policy description. One surplus window is
// weak evidence; only a bundle site that keeps matching the old prose past the
// window is a site nothing catalogues.
describe('checkRemovedIdCoverage: a window that coincides with unrelated text', () => {
  const clause =
    'The fixture upload left out files that a read rule of yours covers, as set in your Claude Code configuration';
  const old = {
    id: 'tool-result-fixture-upload-left-out-read-rule-clause',
    version: '2.1.294',
    pieces: [clause],
    identifiers: [],
    identifierMap: {},
  };
  const successor = {
    id: 'tool-result-fixture-upload-excluded-error',
    version: '2.1.295',
    pieces: [`Upload stopped. ${clause}, so retry after removing them.`],
    identifiers: [],
    identifierMap: {},
  };
  const catalogued = `x=\`Upload stopped. ${clause}, so retry after removing them.\``;
  const unrelated =
    'y="Servers are loaded from the Claude Code configuration-file section."';

  it('does not flag a surplus window that continues into unrelated text', () => {
    const out = run(
      write('cli-coin.js', `${catalogued};${unrelated}`),
      write('prev-coin.json', { prompts: [old] }),
      write('cur-coin.json', { prompts: [successor] })
    );
    expect(out).toMatch(/1 renamed\/reshuffled/);
    expect(out).toMatch(/0 STILL IN BUNDLE/);
    expect(out).toMatch(/removed-id coverage: PASS/);
  });

  it('still flags the same clause surviving verbatim at an uncatalogued site', () => {
    const out = run(
      write('cli-coin2.js', `${catalogued};${unrelated};z="${clause}"`),
      write('prev-coin2.json', { prompts: [old] }),
      write('cur-coin2.json', { prompts: [successor] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*tool-result-fixture-upload-left-out-read-rule-clause/
    );
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  it('flags a short old line that survives whole at an uncatalogued site', () => {
    const line = 'Retry the fixture upload after trimming.';
    const shortOld = {
      id: 'tool-result-fixture-short-line',
      version: '2.1.294',
      pieces: [line],
      identifiers: [],
      identifierMap: {},
    };
    const shortCur = {
      id: 'tool-result-fixture-short-line-renamed',
      version: '2.1.295',
      pieces: [line],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write('cli-short.js', `a="${line}";b=\`${line}\``),
      write('prev-short.json', { prompts: [shortOld] }),
      write('cur-short.json', { prompts: [shortCur] })
    );
    expect(out).toMatch(/STILL IN BUNDLE[\s\S]*tool-result-fixture-short-line /);
  });

  // The bundle stores an em dash as `\u2014`, a middle dot as `\xB7` and a quote
  // inside a quoted string as `\"`; the run must read through those encodings
  // or a survivor holding one reads as a coincidence.
  it('follows the old line through JS escapes in the bundle', () => {
    const line =
      'Note \u2014 a few quick questions to finish it up \u00b7 "said" twice';
    const draftOld = {
      id: 'agent-prompt-fixture-draft-old',
      version: '2.1.294',
      pieces: [line],
      identifiers: [],
      identifierMap: {},
    };
    const draftNew = {
      id: 'agent-prompt-fixture-draft-new',
      version: '2.1.295',
      pieces: [`Intro text. ${line} Then go on.`],
      identifiers: [],
      identifierMap: {},
    };
    const src =
      'Note \\u2014 a few quick questions to finish it up \\xB7 \\"said\\" twice';
    const out = run(
      write(
        'cli-esc.js',
        `a="Intro text. ${src} Then go on.";b="${src}"`
      ),
      write('prev-esc.json', { prompts: [draftOld] }),
      write('cur-esc.json', { prompts: [draftNew] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*agent-prompt-fixture-draft-old/
    );
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });
});

// CC 2.1.296: the second-person Artifact tool description was reworded into a
// third-person module, and one of its sentences survived verbatim inside an id
// that was already catalogued. No successor cleared the rename share, so the
// mid-body probe branch saw that sentence in the bundle and called the id
// IN-BUNDLE although the catalogue covers every site holding it.
describe('checkRemovedIdCoverage: a reworded body whose survivors are catalogued', () => {
  const kept =
    'Publishing makes the page reachable by anyone holding the share link until it is unpublished.';
  const old = {
    id: 'tool-description-fixture-artifact-second-person',
    version: '2.1.295',
    pieces: [
      `You render the file you wrote as a page and hand it to the people you work with.\n${kept}\nYou never publish a file you did not write yourself without asking first.`,
    ],
    identifiers: [],
    identifierMap: {},
  };
  const live = {
    id: 'tool-description-fixture-artifact-third-person',
    version: '2.1.295',
    pieces: [
      `Claude renders an HTML file it made as a page for the people it works with.\n${kept}`,
    ],
    identifiers: [],
    identifierMap: {},
  };
  const catalogued = `x=\`${live.pieces[0].replace('\n', '\\n')}\``;

  it('calls it removed when every live probe sits at a catalogued site', () => {
    const out = run(
      write('cli-spread.js', catalogued),
      write('prev-spread.json', { prompts: [old, live] }),
      write('cur-spread.json', { prompts: [live] })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE/);
    expect(out).not.toMatch(/STILL IN BUNDLE —/);
    expect(out).toMatch(
      /truly removed, no recorded verdict:\s+tool-description-fixture-artifact-second-person/
    );
  });

  it('still flags it when the sentence also survives at an uncatalogued site', () => {
    const out = run(
      write('cli-spread-stray.js', `${catalogued};y="${kept}"`),
      write('prev-spread-stray.json', { prompts: [old, live] }),
      write('cur-spread-stray.json', { prompts: [live] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-artifact-second-person/
    );
  });
});

// Review of the 2.1.296 fix: two ways the catalogue-coverage test could hide a
// line still shipped under no id.
describe('checkRemovedIdCoverage: coverage counts only named catalogue sites', () => {
  it('flags a short surviving line whose surrounding text changed', () => {
    const old = {
      id: 'tool-description-fixture-publish-approval',
      version: '2.1.295',
      pieces: [
        'Keep draft contents confidential — Publish pages only after explicit approval.',
      ],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write('cli-short.js', 'x="Publish pages only after explicit approval."'),
      write('prev-short.json', { prompts: [old] }),
      write('cur-short.json', { prompts: [] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-publish-approval/
    );
  });

  it('does not count an anonymous capture or the sidecar as coverage', () => {
    const kept =
      'Publishing makes the page reachable by anyone holding the share link until it is unpublished.';
    const old = {
      id: 'tool-description-fixture-artifact-anon',
      version: '2.1.295',
      pieces: [
        `You render the file you wrote as a page.\n${kept}\nYou never publish a file you did not write yourself without asking first.`,
      ],
      identifiers: [],
      identifierMap: {},
    };
    const anonBody = `Claude renders an HTML file it made as a page.\\n${kept}`;
    const anon = {
      id: '',
      version: '2.1.296',
      pieces: [anonBody],
      identifiers: [],
      identifierMap: {},
    };
    const sidecarDir = path.join(dir, 'sidecar-anon');
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(
      path.join(sidecarDir, 'classify-chunk-00.json'),
      JSON.stringify([{ hash: 'f'.repeat(40), body: anonBody }])
    );
    let out;
    try {
      out = execFileSync(
        process.execPath,
        [
          TOOL,
          write('cli-anon.js', `x=\`${anonBody}\`;y="${kept}"`),
          write('prev-anon.json', { prompts: [old] }),
          write('cur-anon.json', { prompts: [anon] }),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TWEAKCC_CLASSIFY_DIR: sidecarDir,
            TWEAKCC_RENAME_MAP: path.join(dir, 'renames.json'),
          },
        }
      );
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-artifact-anon/
    );
  });
});

describe('checkRemovedIdCoverage: every live run, each site once', () => {
  const sentences = [
    'Tag the release branch before the freeze window opens on Monday.',
    'Attach the signed checksum file to every published archive.',
    'Run the migration dry run against a copy of production data.',
    'Confirm the rollback script restores the previous schema cleanly.',
    'Announce the maintenance window in the status channel first.',
    'Rotate the deploy key whenever a maintainer leaves the project.',
    'Keep the changelog entries grouped by user-visible impact.',
    'Verify the container image digest matches the build manifest.',
    'Archive the old documentation site under a versioned path.',
    'Notify downstream packagers once the tarball is mirrored.',
    'Close the milestone only after every blocker is triaged.',
    'Record the release duration so the next estimate improves.',
  ];
  const line = n => sentences[n - 10];

  it('flags head and tail lines the mid-body probes never look at', () => {
    const lines = Array.from({ length: 12 }, (_, i) => line(i + 10));
    const old = {
      id: 'tool-description-fixture-long-checklist',
      version: '2.1.295',
      pieces: [lines.join('\n')],
      identifiers: [],
      identifierMap: {},
    };
    const moved = {
      id: 'tool-description-fixture-checklist-middle',
      version: '2.1.296',
      pieces: [lines.slice(2, 9).join('\n')],
      identifiers: [],
      identifierMap: {},
    };
    const stray = [...lines.slice(0, 2), ...lines.slice(10)].join('\\n');
    const out = run(
      write(
        'cli-long.js',
        `x=\`${lines.slice(2, 9).join('\\n')}\`;y=\`${stray}\``
      ),
      write('prev-long.json', { prompts: [old, moved] }),
      write('cur-long.json', { prompts: [moved] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-long-checklist/
    );
  });

  it('counts a fragment nested in its composite parent as one site', () => {
    const kept =
      'Secrets stay in the vault and never enter the conversation transcript.';
    const old = {
      id: 'tool-description-fixture-secret-handling',
      version: '2.1.295',
      pieces: [
        [
          'Rotate the token after every incident review.',
          'Page the on-call owner before you revoke a production key.',
          'Record each rotation in the audit log with its ticket number.',
          kept,
        ].join('\n'),
      ],
      identifiers: [],
      identifierMap: {},
    };
    const parent = {
      id: 'tool-description-fixture-vault-parent',
      version: '2.1.296',
      pieces: [`Use the vault for credentials. ${kept}`],
      identifiers: [],
      identifierMap: {},
    };
    const fragment = {
      id: 'tool-description-fixture-vault-fragment',
      version: '2.1.296',
      pieces: [kept],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write(
        'cli-nested.js',
        `x="Use the vault for credentials. ${kept}";y="${kept}"`
      ),
      write('prev-nested.json', { prompts: [old, parent, fragment] }),
      write('cur-nested.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-secret-handling/
    );
  });
});
