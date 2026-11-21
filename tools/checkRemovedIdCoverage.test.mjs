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
      pieces: [
        'This element (${',
        '}) cannot be ${',
        '[_.kind]} while ${',
        ')} is in the ',
      ],
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

  it('does not treat a code-only piece as prompt text surviving in the bundle', () => {
    // CC 2.1.330: the template holding this fragment is gone, but the call it
    // wrapped is still code in the bundle.
    const prompt = {
      id: 'tool-result-fixture-code-only-fragment',
      version: '2.1.296',
      pieces: ['${', '(', '.reasonCode??"canvas",', ',', ',', ')}.'],
      identifiers: [0, 1, 2, 3, 4],
      identifierMap: { 0: 'A', 1: 'B', 2: 'C', 3: 'D', 4: 'E' },
    };
    const out = run(
      write('cli-code.js', 'Vi=Pn?Ic:Vn(y.reasonCode??"canvas",u,_,it);'),
      write('prev-code.json', { prompts: [prompt] }),
      write('cur-code.json', { prompts: [] })
    );
    expect(out).not.toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-result-fixture-code-only-fragment/
    );
    expect(out).toMatch(
      /NO PROBE SURFACE[\s\S]*tool-result-fixture-code-only-fragment/
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
    expect(run(cli, prev, cur)).toMatch(
      /1 truly removed \(1 need a decision\)/
    );
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
        'slash-command-fixture-ruled-ui': {
          verdict: 'archived',
          facing: 'ui',
          hash,
        },
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
        'slash-command-fixture-ruled-ui': {
          verdict: 'archived',
          facing: 'ui',
          hash,
        },
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
    ...tpl('no worktree or output to check — resume', 'with SendMessage only.'),
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
      pieces: [
        'Resume it by sending it a message with ${',
        '} to get its report.',
      ],
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
    const map = JSON.parse(
      fs.readFileSync(path.join(dir, 'renames.json'), 'utf8')
    );
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
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*tool-result-fixture-short-line /
    );
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
      write('cli-esc.js', `a="Intro text. ${src} Then go on.";b="${src}"`),
      write('prev-esc.json', { prompts: [draftOld] }),
      write('cur-esc.json', { prompts: [draftNew] })
    );
    expect(out).toMatch(/STILL IN BUNDLE[\s\S]*agent-prompt-fixture-draft-old/);
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

  // CC 2.1.305: a slot-heavy error was reworded and its only surviving 25-char
  // window sat inside a sibling id that was already catalogued.
  it('does not flag a slot-heavy body whose only live window a named id holds', () => {
    const old = {
      id: 'tool-result-fixture-fence-detail',
      version: '2.1.304',
      pieces: [
        'sandbox user to ${',
        '.target} succeeded. Re-run \\`fixture install\\` (one prompt). (${',
        '.stderr})',
      ],
      identifiers: [0, 1],
      identifierMap: { 0: 'VAR_0', 1: 'VAR_1' },
    };
    const sibling = {
      id: 'tool-result-fixture-verify-detail',
      version: '2.1.305',
      pieces: [
        'The fence may be absent. Re-run \\`fixture install\\`. (${',
        '.stderr})',
      ],
      identifiers: [0],
      identifierMap: { 0: 'VAR_0' },
    };
    const out = run(
      write(
        'cli-fence.js',
        'x=`The fence may be absent. Re-run \\`fixture install\\`. (${e.stderr})`'
      ),
      write('prev-fence.json', { prompts: [old] }),
      write('cur-fence.json', { prompts: [sibling] })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE/);
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
        `x="Use the vault for credentials. ${kept}";y="Reminder: ${kept}"`
      ),
      write('prev-nested.json', { prompts: [old, parent, fragment] }),
      write('cur-nested.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-secret-handling/
    );
  });
});

describe('checkRemovedIdCoverage: fragment nested as an escaped slot literal', () => {
  it('counts the fragment inside its parent once and still sees an extra site', () => {
    const kept =
      'The result includes a path for the operator to repeat by hand.';
    const fragment = {
      id: 'tool-description-fixture-runner-suffix',
      pieces: [`\n${kept}`],
      identifiers: [],
      identifierMap: {},
    };
    const parent = {
      id: 'tool-description-fixture-runner-list',
      pieces: [`List the runners.\${"\\n${kept}"}`],
      identifiers: [],
      identifierMap: {},
    };
    const old = {
      id: 'tool-description-fixture-runner-old',
      pieces: [`Old runner text that is gone now.\n${kept}`],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write(
        'escaped-nested-cli.js',
        `a=\`List the runners.\${"\\n${kept}"}\`;c="${kept}"`
      ),
      write('escaped-nested-prev.json', { prompts: [old, parent, fragment] }),
      write('escaped-nested-cur.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*tool-description-fixture-runner-old/
    );
  });
});

describe('checkRemovedIdCoverage: contextual coverage in rename and split branches', () => {
  const kept =
    'Secrets stay in the vault and never enter the conversation transcript.';
  const other =
    'Rotate the deploy key whenever a maintainer leaves the project.';
  const old = {
    id: 'fixture-old-secrets',
    pieces: [kept],
    identifiers: [],
    identifierMap: {},
  };
  const parent = {
    id: 'fixture-parent-secrets',
    pieces: [`Use the vault for credentials. ${kept}`],
    identifiers: [],
    identifierMap: {},
  };
  const fragment = {
    id: 'fixture-fragment-secrets',
    pieces: [kept],
    identifiers: [],
    identifierMap: {},
  };

  it('flags an extra source site hidden by a fragment nested in the rename successor', () => {
    const out = run(
      write(
        'rename-nested-cli.js',
        `x="${parent.pieces[0]}";y="Reminder: ${kept}"`
      ),
      write('rename-nested-prev.json', { prompts: [old] }),
      write('rename-nested-cur.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-old-secrets/);
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  it('passes the nested rename when the bundle has no surplus contextual site', () => {
    const out = run(
      write('rename-covered-cli.js', `x="${parent.pieces[0]}"`),
      write('rename-covered-prev.json', { prompts: [old] }),
      write('rename-covered-cur.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(/1 renamed\/reshuffled/);
    expect(out).toMatch(/0 STILL IN BUNDLE/);
  });

  it('flags an extra source site hidden by nested fragments after a split', () => {
    const splitOld = { ...old, pieces: [`${kept}\n${other}`] };
    const secondParent = {
      id: 'fixture-second-parent',
      pieces: [`Deployment notes: ${other}`],
      identifiers: [],
      identifierMap: {},
    };
    const secondFragment = {
      ...secondParent,
      id: 'fixture-second-fragment',
      pieces: [other],
    };
    const out = run(
      write(
        'split-nested-cli.js',
        `x="${parent.pieces[0]}";y="${secondParent.pieces[0]}";z="Reminder: ${kept}"`
      ),
      write('split-nested-prev.json', { prompts: [splitOld] }),
      write('split-nested-cur.json', {
        prompts: [parent, fragment, secondParent, secondFragment],
      })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-old-secrets/);
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  it('deduplicates nested slot-bearing bodies despite different identifier labels', () => {
    const lead = 'Secrets stay in the protected vault under tenant ';
    const tail = ' and never enter the conversation transcript.';
    const slotted = {
      id: 'fixture-slotted-fragment',
      pieces: [lead + '${', '}' + tail],
      identifiers: [0],
      identifierMap: { 0: 'FRAGMENT_TENANT' },
    };
    const slottedParent = {
      ...slotted,
      id: 'fixture-slotted-parent',
      pieces: ['Use the vault. ' + lead + '${', '}' + tail],
      identifierMap: { 0: 'PARENT_TENANT' },
    };
    const slottedOld = {
      ...slotted,
      id: 'fixture-old-slotted',
      identifierMap: { 0: 'OLD_TENANT' },
    };
    const out = run(
      write(
        'rename-slotted-cli.js',
        'x=`Use the vault. ' +
          lead +
          '${a}' +
          tail +
          '`;y=`Reminder: ' +
          lead +
          '${b}' +
          tail +
          '`'
      ),
      write('rename-slotted-prev.json', { prompts: [slottedOld] }),
      write('rename-slotted-cur.json', { prompts: [slottedParent, slotted] })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-old-slotted/);
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  const lead = 'Secrets stay in the protected vault under tenant ';
  const tail = ' and never enter the conversation transcript.';
  const oldSlotted = {
    id: 'fixture-old-mixed-slots',
    pieces: [lead + '${', '}' + tail],
    identifiers: [0],
    identifierMap: { 0: 'OLD_TENANT' },
  };
  const promotedParent = {
    id: 'fixture-parent-mixed-slots',
    pieces: ['Use the vault. ' + lead + '${', '(', ')}' + tail],
    identifiers: [0, 1],
    identifierMap: { 0: 'CONVERT', 1: 'PARENT_TENANT' },
  };
  const bakedChild = {
    id: 'fixture-child-mixed-slots',
    pieces: [lead + '${String(', ')}' + tail],
    identifiers: [0],
    identifierMap: { 0: 'CHILD_TENANT' },
  };
  const mixedSource =
    'x=`Use the vault. ' + lead + '${String(a)}' + tail + '`;';

  it('flags a stranded site despite promoted and baked converter segmentation', () => {
    const out = run(
      write(
        'mixed-cli.js',
        mixedSource + 'y=`Reminder: ' + lead + '${String(b)}' + tail + '`;'
      ),
      write('mixed-prev.json', { prompts: [oldSlotted] }),
      write('mixed-cur.json', { prompts: [promotedParent, bakedChild] })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-old-mixed-slots/);
    expect(out).toMatch(/removed-id coverage: FAIL/);
  });

  it('passes mixed segmentation when only the parent emission survives', () => {
    const out = run(
      write('mixed-covered-cli.js', mixedSource),
      write('mixed-covered-prev.json', { prompts: [oldSlotted] }),
      write('mixed-covered-cur.json', { prompts: [promotedParent, bakedChild] })
    );
    expect(out).toMatch(/1 renamed\/reshuffled/);
    expect(out).toMatch(/removed-id coverage: PASS/);
  });

  it.each([
    ['operator', '+ 1', '- 1'],
    ['literal', ', {key: "first"}', ', {key: "second"}'],
    ['property key', ', {first: 1}', ', {second: 1}'],
  ])(
    'keeps distinct %s expressions as independently covered emissions',
    (_kind, first, second) => {
      const parent = {
        ...promotedParent,
        pieces: ['Use the vault. ' + lead + '${', '(', first + ')}' + tail],
      };
      const child = {
        ...bakedChild,
        pieces: [lead + '${String(', second + ')}' + tail],
      };
      const out = run(
        write(
          'distinct-cli.js',
          'x=`Use the vault. ' +
            lead +
            '${String(a' +
            first +
            ')}' +
            tail +
            '`;y=`' +
            lead +
            '${String(b' +
            second +
            ')}' +
            tail +
            '`;'
        ),
        write('distinct-prev.json', { prompts: [oldSlotted] }),
        write('distinct-cur.json', { prompts: [parent, child] })
      );
      expect(out).toMatch(/removed-id coverage: PASS/);
      expect(out).toMatch(/0 STILL IN BUNDLE/);
    }
  );

  it('normalizes nested template and regex syntax without ending on literal braces', () => {
    const syntax = ', {key: `} ${a}`, pattern: /[}]/}';
    const parent = {
      ...promotedParent,
      pieces: ['Use the vault. ' + lead + '${', '(', syntax + ')}' + tail],
    };
    const child = {
      ...bakedChild,
      pieces: [
        lead + '${String(',
        syntax.replace('${a}', '${b}') + ')}' + tail,
      ],
    };
    const out = run(
      write(
        'nested-expression-cli.js',
        'x=`Use the vault. ' +
          lead +
          '${String(a' +
          syntax +
          ')}' +
          tail +
          '`;y=`Reminder: ' +
          lead +
          '${String(b' +
          syntax.replace('${a}', '${b}') +
          ')}' +
          tail +
          '`;'
      ),
      write('nested-expression-prev.json', { prompts: [oldSlotted] }),
      write('nested-expression-cur.json', { prompts: [parent, child] })
    );
    expect(out).toMatch(/removed-id coverage: FAIL/);
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-old-mixed-slots/);
  });
});

describe('checkRemovedIdCoverage: catalogued sites counted by bundle location', () => {
  const lead = 'You are reviewing for **recall** at ${';
  const leadTail =
    '==="max"?"maximum":"extra-high"} effort: catch every real bug.';
  const leadIn = {
    id: 'fixture-review-lead-in',
    pieces: [lead, leadTail],
    identifiers: [0],
    identifierMap: { 0: 'EFFORT_LEVEL' },
  };
  const header = {
    id: 'fixture-review-header',
    pieces: ['Header line for the maximum review tier.\n\n' + lead, leadTail],
    identifiers: [0],
    identifierMap: { 0: 'EFFORT_LEVEL' },
  };
  const oldReview = {
    id: 'fixture-review-old-tier',
    pieces: [
      lead,
      leadTail +
        '\nWeigh every candidate against the diff before you report it.',
    ],
    identifiers: [0],
    identifierMap: { 0: 'OLD_LEVEL' },
  };
  const slot = '${e==="max"?"maximum":"extra-high"}';
  const leadSource =
    'You are reviewing for **recall** at ' +
    slot +
    ' effort: catch every real bug.';
  const reviewCli =
    'x=`Header line for the maximum review tier.\n\n' +
    leadSource +
    '`;y={leadIn:`' +
    leadSource +
    '`};';

  it('counts a lead-in template as its own site although a header embeds its text', () => {
    const out = run(
      write('lead-in-cli.js', reviewCli),
      write('lead-in-prev.json', { prompts: [oldReview, leadIn, header] }),
      write('lead-in-cur.json', { prompts: [leadIn, header] })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE/);
    expect(out).toMatch(/removed-id coverage: PASS/);
  });

  it('still flags a third copy of the lead-in that nothing catalogues', () => {
    const out = run(
      write(
        'lead-in-extra-cli.js',
        reviewCli + 'z=`Elsewhere: ' + leadSource + '`;'
      ),
      write('lead-in-extra-prev.json', {
        prompts: [oldReview, leadIn, header],
      }),
      write('lead-in-extra-cur.json', { prompts: [leadIn, header] })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-review-old-tier/);
  });

  const refused = 'Write refused; nothing in the project was changed.';
  const prefix = {
    id: 'fixture-write-refused-prefix',
    pieces: [refused],
    identifiers: [],
    identifierMap: {},
  };
  const reasons = [
    'The doc at this path has changed since you last read it.',
    'This session cannot check if_version on this path.',
  ];
  const refusals = reasons.map((r, i) => ({
    id: `fixture-write-refused-reason-${i}`,
    pieces: [`${refused} ${r}`],
    identifiers: [],
    identifierMap: {},
  }));
  const oldRefusal = {
    id: 'fixture-write-refused-over-size',
    pieces: [
      `${refused}\nThis text is over the size limit for a single doc, so split it into several smaller docs at new paths.`,
    ],
    identifiers: [],
    identifierMap: {},
  };
  const refusedCli =
    `var ee="${refused}";` +
    reasons.map((r, i) => `var r${i}="${refused} ${r}";`).join('');

  it('counts a standalone constant as its own site although longer messages open with it', () => {
    const out = run(
      write('refused-cli.js', refusedCli),
      write('refused-prev.json', {
        prompts: [oldRefusal, prefix, ...refusals],
      }),
      write('refused-cur.json', { prompts: [prefix, ...refusals] })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE/);
    expect(out).toMatch(/removed-id coverage: PASS/);
  });

  it('still flags a second standalone copy of the constant', () => {
    const out = run(
      write('refused-extra-cli.js', `${refusedCli}var e2="${refused}";`),
      write('refused-extra-prev.json', {
        prompts: [oldRefusal, prefix, ...refusals],
      }),
      write('refused-extra-cur.json', { prompts: [prefix, ...refusals] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE —[\s\S]*fixture-write-refused-over-size/
    );
  });
});

describe('checkRemovedIdCoverage: windows never span slot source', () => {
  it('does not read a literal inside a removed slot expression as the prompt surviving', () => {
    const old = {
      id: 'slash-command-fixture-reconnect-pending',
      pieces: [
        '"${',
        '(',
        ')}" is pending approval.${',
        '(" Approve it with `/mcp` in the terminal first."," Open MCP servers from the command menu.")}',
      ],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'A', 1: 'B', 2: 'C' },
    };
    const hint = {
      id: 'slash-command-fixture-open-from-menu-hint',
      pieces: [' Open MCP servers from the command menu.'],
      identifiers: [],
      identifierMap: {},
    };
    const out = run(
      write(
        'slot-source-cli.js',
        'q=`Server ${n} needs approval.${b(" Approve it with `/mcp` in the terminal first."," Open MCP servers from the command menu.")}`;' +
          'r=`Server ${n} failed.${b(" Run /mcp."," Open MCP servers from the command menu.")}`;'
      ),
      write('slot-source-prev.json', { prompts: [old, hint] }),
      write('slot-source-cur.json', { prompts: [hint] })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE/);
    expect(out).toMatch(/1 truly removed/);
  });
});

describe('checkRemovedIdCoverage: a fragment is placed only where it fills a whole literal', () => {
  const kept =
    'Secrets stay in the vault and never enter the conversation transcript.';
  const parent = {
    id: 'fixture-place-parent',
    pieces: [`Use the vault for credentials. ${kept}`],
    identifiers: [],
    identifierMap: {},
  };
  const fragment = {
    id: 'fixture-place-fragment',
    pieces: [kept],
    identifiers: [],
    identifierMap: {},
  };
  const old = {
    id: 'fixture-place-old',
    pieces: [kept],
    identifiers: [],
    identifierMap: {},
  };

  it('does not take a quoted run inside a template for a string literal', () => {
    const out = run(
      write(
        'place-quoted-cli.js',
        `x="${parent.pieces[0]}";z=\`If the tool prints "${kept}" stop and report.\``
      ),
      write('place-quoted-prev.json', { prompts: [old] }),
      write('place-quoted-cur.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-place-old/);
  });

  it('does not take a template chunk between two slots for a whole literal', () => {
    const out = run(
      write(
        'place-slots-cli.js',
        `x="${parent.pieces[0]}";z=\`Note for \${u}${kept}\${w} more\``
      ),
      write('place-slots-prev.json', { prompts: [old] }),
      write('place-slots-cur.json', { prompts: [parent, fragment] })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-place-old/);
  });

  it('does not place a slotted fragment on a template that shares only its tail', () => {
    const lead = 'Secrets stay in the protected vault under tenant ';
    const tail = ' and never enter the conversation transcript of any kind.';
    const slottedParent = {
      id: 'fixture-place-slotted-parent',
      pieces: ['Use the vault. ' + lead + '${', '}' + tail],
      identifiers: [0],
      identifierMap: { 0: 'P' },
    };
    const slottedFragment = {
      id: 'fixture-place-slotted-fragment',
      pieces: [lead + '${', '}' + tail],
      identifiers: [0],
      identifierMap: { 0: 'F' },
    };
    const slottedOld = {
      id: 'fixture-place-slotted-old',
      pieces: ['Hi there ${', '}' + tail],
      identifiers: [0],
      identifierMap: { 0: 'O' },
    };
    const out = run(
      write(
        'place-tail-cli.js',
        'x=`Use the vault. ' +
          lead +
          '${a}' +
          tail +
          '`;y=`Hi there ${b}' +
          tail +
          '`'
      ),
      write('place-tail-prev.json', { prompts: [slottedOld] }),
      write('place-tail-cur.json', {
        prompts: [slottedParent, slottedFragment],
      })
    );
    expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-place-slotted-old/);
  });
});

describe('checkRemovedIdCoverage: a run inside a slot is pinned to its place in the expression', () => {
  const kept =
    'Secrets stay in the vault and never enter the conversation transcript.';
  const wrapper = {
    id: 'fixture-slot-wrapper',
    pieces: ['${', '("' + kept + '")}\n\n${', '}'],
    identifiers: [0, 1],
    identifierMap: { 0: 'F', 1: 'B' },
  };
  const fragment = {
    id: 'fixture-slot-fragment',
    pieces: [kept],
    identifiers: [],
    identifierMap: {},
  };
  const old = {
    id: 'fixture-slot-old',
    pieces: [kept],
    identifiers: [],
    identifierMap: {},
  };
  const real = 'x=`${f("' + kept + '")}\\n\\n${b}`;';

  it.each([
    ['string', `"Note: ${kept} Extra."`],
    ['template', `\`Note: ${kept} Extra.\``],
  ])(
    'flags a %s stray in another template slot of the same shape',
    (kind, arg) => {
      const out = run(
        write(
          `slot-pin-${kind}-cli.js`,
          `${real}z=\`\${g(${arg})}\\n\\n\${c}\`;`
        ),
        write(`slot-pin-${kind}-prev.json`, { prompts: [old] }),
        write(`slot-pin-${kind}-cur.json`, { prompts: [wrapper, fragment] })
      );
      expect(out).toMatch(/STILL IN BUNDLE —[\s\S]*fixture-slot-old/);
    }
  );

  it('passes when the run sits only at the catalogued slot', () => {
    const out = run(
      write('slot-pin-control-cli.js', real),
      write('slot-pin-control-prev.json', { prompts: [old] }),
      write('slot-pin-control-cur.json', { prompts: [wrapper, fragment] })
    );
    expect(out).toMatch(/0 STILL IN BUNDLE/);
  });
});
