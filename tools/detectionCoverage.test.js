// Locks the detection-coverage gate against the miss it was built for: prompts
// assembled from several AST nodes, which the extractor's per-node gating cannot
// see as a unit. Regression target = the real 2.1.220 shapes.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  collectComposites,
  looksLikeProse,
  isDroppedByContext,
  isCaptured,
} = require('./detectionCoverage.js');

const textOf = (composites, needle) =>
  composites.find(c => c.text.includes(needle));

describe('detectionCoverage: composite collection', () => {
  it('assembles an inline array .join() — the Opus 5 shape', () => {
    const code =
      'ttp=["Do not call the AgentTool unless the user requested it",' +
      '"Do not use workflows or deep-research unless the user requested it"].join(`\\n`);';
    const hit = textOf(collectComposites(code), 'Do not call the AgentTool');
    expect(hit).toBeDefined();
    expect(hit.shape).toBe('array');
    // both fragments present as ONE unit — that is the whole point
    expect(hit.text).toContain('deep-research');
  });

  it('assembles an array joined elsewhere, not just an inline .join()', () => {
    const code =
      'var A=["## Keystroke Syntax","- `ctrl` (alias: `control`)"];f(A.join("\\n"));';
    const hit = textOf(collectComposites(code), 'Keystroke Syntax');
    expect(hit).toBeDefined();
    expect(hit.text).toContain('control');
  });

  it('assembles a "a" + "b" concatenation chain', () => {
    const code =
      'x=E.string().describe("Invokes an MCP tool via the " + "subprocess MCP client.");';
    const hit = textOf(collectComposites(code), 'Invokes an MCP tool');
    expect(hit).toBeDefined();
    expect(hit.shape).toBe('concat');
    expect(hit.text).toContain('subprocess MCP client');
  });
});

describe('detectionCoverage: prose gate', () => {
  it('accepts real instructional prose', () => {
    expect(
      looksLikeProse(
        'Do not call the AgentTool unless the user requested it. ' +
          'You should not use workflows or deep research when it is not asked for.'
      )
    ).toBe(true);
  });

  it('rejects identifier soup that is full of real words but has no grammar', () => {
    // the DTD catalogue / syntax-highlighter keyword tables that flooded v1
    expect(
      looksLikeProse(
        'array bigint bool byte char datetime decimal double single string ' +
          'switch table timespan uint ulong ushort variant version void'
      )
    ).toBe(false);
  });

  it('rejects contributor blocks', () => {
    expect(
      looksLikeProse(
        'Pierre Inglebert <pierre.inglebert@gmail.com> Jonathan Ong ' +
          '<jonathanrichardong@gmail.com> Chanon Sajjamanochai <chanon.s@gmail.com> ' +
          'and the rest of you who are listed with us in this file for it'
      )
    ).toBe(false);
  });
});

describe('detectionCoverage: drop contexts', () => {
  it('leaves thrown messages to the classifier instead of dropping them', () => {
    // A tool's thrown error is the tool_result the model reads, so the site
    // alone is not evidence of facing.
    expect(
      isDroppedByContext(
        'Cannot enter worktree: the target is the current working directory.',
        'if(L8i===void 0)throw Error('
      )
    ).toBe(false);
  });

  it('still drops a vendored SDK message by its package scope', () => {
    expect(
      isDroppedByContext(
        'Install @azure/identity-broker to use the broker credential.',
        'if(L8i===void 0)throw Error('
      )
    ).toBe(true);
  });

  it('drops TUI demo frames and shell shims', () => {
    expect(isDroppedByContext('> run tests [success:✓] done', 'x=')).toBe(true);
    expect(isDroppedByContext('#!/bin/sh\necho hi', 'x=')).toBe(true);
  });

  it('does NOT drop a normal prompt assignment', () => {
    expect(
      isDroppedByContext('Do not call the AgentTool unless asked.', 'ttp=')
    ).toBe(false);
  });
});

describe('detectionCoverage: capture test', () => {
  const corpus =
    ' Wait for MCP servers that are still connecting and whose tools are not yet in your tool list. ';

  it('sees a prompt that IS in the corpus', () => {
    expect(
      isCaptured(
        corpus,
        'Wait for MCP servers that are still connecting and whose tools are not yet in your tool list.'
      )
    ).toBe(true);
  });

  it('flags a prompt that is absent', () => {
    expect(
      isCaptured(
        corpus,
        'Do not call the AgentTool unless the user requested it, ever.'
      )
    ).toBe(false);
  });

  it('tolerates piece-splitting at interpolation boundaries', () => {
    // extractor stores pieces split at ${...}; a probe must survive that
    expect(
      isCaptured(
        corpus,
        '${PREFIX}Wait for MCP servers that are still connecting and whose tools are not yet in your tool list.'
      )
    ).toBe(true);
  });
});

// The extractor must never STORE a joined composite. The joined form exists
// only at runtime — cli.js holds ["a","b"].join("\n") — so a regex built from
// it can never match the bundle and every apply reports "Could not find".
// Regression for the 3-per-set CnF this caused before fragments became the
// stored unit.
describe('detectionCoverage: composites are evidence, not stored prompts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const JSON_PATH = path.join(
    __dirname,
    '..',
    'data',
    'prompts',
    'prompts-2.1.220.json'
  );

  it('the Opus 5 pair is catalogued as two splicable fragments, not one joined string', () => {
    if (!fs.existsSync(JSON_PATH)) return;
    const prompts = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')).prompts;
    const bodies = prompts.map(p => (p.pieces || []).join(''));
    expect(bodies).toContain(
      'Do not call the AgentTool unless the user requested it'
    );
    expect(bodies).toContain(
      'Do not use workflows or deep-research unless the user requested it'
    );
    // the joined form must NOT be stored
    const joined = bodies.find(
      b =>
        b.includes('Do not call the AgentTool') &&
        b.includes('Do not use workflows')
    );
    expect(joined).toBeUndefined();
  });
});

describe('detectionCoverage: defers to the classification cache', () => {
  const ex = require('./promptExtractor.js');
  const { isJudgedNotModelFacing } = require('./detectionCoverage.js');
  const text =
    'Cannot enter worktree: the target is the current working directory.';

  it('silences only a ui/internal verdict on the assembled text', () => {
    try {
      for (const [facing, silent] of [
        ['ui', true],
        ['internal', true],
        ['model', false],
      ]) {
        ex._setClassificationCacheForTests({ [ex.sha1Hex(text)]: { facing } });
        expect(isJudgedNotModelFacing(text)).toBe(silent);
      }
      ex._setClassificationCacheForTests({ _: {} });
      expect(isJudgedNotModelFacing(text)).toBe(false);
    } finally {
      ex._setClassificationCacheForTests(null);
    }
  });
});
