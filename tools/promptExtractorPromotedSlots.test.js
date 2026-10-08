// A slot expression whose first identifier sits behind a literal, such as an
// object literal indexed by a variable, has that identifier promoted to a slot.
// Without promotion the minified index stays in the piece text, pinned to one
// platform's build.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sites = require('./lib/bundleSites.cjs');
const ex = require('./promptExtractor.js');
const parser = require('@babel/parser');

const shapeOf = src => {
  const ast = parser.parse(src);
  const node = ast.program.body[0].expression.right;
  return sites.templateShape(node, src);
};

afterEach(() => vi.restoreAllMocks());

describe('slot promotion in templateShape', () => {
  it('makes the index of an indexed object literal a slot', () => {
    const shape = shapeOf(
      'x=`${{here:"Pass `path` here",none:"Pass `content`"}[e]} then write.`'
    );
    expect(shape.pieces).toEqual([
      '${{here:"Pass `path` here",none:"Pass `content`"}[',
      ']} then write.',
    ]);
    expect(shape.identifiers).toEqual([0]);
    expect(shape.legacy).toEqual({
      pieces: [
        '${{here:"Pass `path` here",none:"Pass `content`"}[e]} then write.',
      ],
      identifiers: [],
      occurrences: [],
    });
  });

  it('promotes ahead of a later slot and keeps the legacy alignment', () => {
    const shape = shapeOf(
      'x=`Check (${c}) ${{asked:"asked",stderr:"failed"}[n]}: ${r}`'
    );
    expect(shape.pieces).toEqual([
      'Check (${',
      '}) ${{asked:"asked",stderr:"failed"}[',
      ']}: ${',
      '}',
    ]);
    expect(shape.identifiers).toEqual([0, 1, 2]);
    expect(shape.legacy.identifiers).toEqual([0, 1]);
    expect(shape.legacy.occurrences).toEqual([0, 2]);
  });

  it('promotes bare object values and computed keys ahead of the index', () => {
    const shape = shapeOf('x=`${{a:v,[k]:"w"}[i]} tail`');
    expect(shape.pieces).toEqual(['${{a:', ',[', ']:"w"}[', ']} tail']);
    expect(shape.identifiers).toEqual([0, 1, 2]);
  });

  it('leaves identifiers after the first capture to the apply side', () => {
    // `o` is captured; `k` follows it and the search regex generalizes it.
    const shape = shapeOf('x=`pick ${o[k]} and ${{a:`t ${y}`}[j]} end`');
    expect(shape.pieces).toEqual([
      'pick ${',
      '[k]} and ${{a:`t ${',
      '}`}[j]} end',
    ]);
    expect(shape.identifiers).toEqual([0, 1]);
    expect(shape.legacy).toBeUndefined();
  });

  it('keeps a shorthand property literal', () => {
    const shape = shapeOf('x=`${{e}.e} end`');
    expect(shape.pieces).toEqual(['${{e}.e} end']);
    expect(shape.identifiers).toEqual([]);
  });

  it('does not promote property names or string contents', () => {
    const shape = shapeOf('x=`${{k:"v"}.k} ${{m:"n"}["m"]} end`');
    expect(shape.identifiers).toEqual([]);
    expect(shape.legacy).toBeUndefined();
  });
});

describe('carryover across slot promotion', () => {
  const legacyPieces = [
    'Install done (user: ${{none:"not provisioned",ok:"provisioned"}[n]}, filters: ${',
    '.wfp.state}). Run it again to retry.',
  ];
  const oldItem = {
    id: 'tool-result-fixture-objlit-install-status',
    name: 'Tool Result: fixture objlit install status',
    description: 'fixture',
    pieces: legacyPieces,
    identifiers: [0],
    identifierMap: { 0: 'INSTALL_RESULT' },
    version: '2.1.200',
  };
  const newItem = {
    name: '',
    id: '',
    description: '',
    pieces: [
      'Install done (user: ${{none:"not provisioned",ok:"provisioned"}[',
      ']}, filters: ${',
      '.wfp.state}). Run it again to retry.',
    ],
    identifiers: [0, 1],
    identifierMap: { 0: '', 1: '' },
    legacy: { pieces: legacyPieces, identifiers: [0], occurrences: [1] },
  };

  it('moves each carried name to the slot it named', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompts } = ex.mergeWithExisting(
      { prompts: [newItem] },
      { prompts: [oldItem] },
      '2.1.300'
    );
    expect(prompts[0].id).toBe(oldItem.id);
    expect(prompts[0].identifierMap).toEqual({ 1: 'INSTALL_RESULT' });
    // The pristine body changed form, so the override is flagged for review.
    expect(prompts[0].version).toBe('2.1.300');
    ex.fillSlotNames(prompts[0]);
    expect(prompts[0].identifierMap).toEqual({
      0: 'TOOL_RESULT_FIXTURE_OBJLIT_INSTALL_STATUS_VAR_1',
      1: 'INSTALL_RESULT',
    });
  });

  it('names unpromoted slots from their pre-promotion labels', () => {
    const p = {
      ...newItem,
      id: 'tool-result-fixture-objlit-fresh',
      identifierMap: { 0: '', 1: '' },
    };
    ex.fillSlotNames(p);
    expect(p.identifierMap).toEqual({
      0: 'TOOL_RESULT_FIXTURE_OBJLIT_FRESH_VAR_1',
      1: 'TOOL_RESULT_FIXTURE_OBJLIT_FRESH_VAR_0',
    });
  });

  it('carries a map already in the promoted shape unchanged', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const current = {
      ...oldItem,
      pieces: newItem.pieces,
      identifiers: [0, 1],
      identifierMap: { 0: 'STATUS_KEY', 1: 'INSTALL_RESULT' },
    };
    const { prompts } = ex.mergeWithExisting(
      { prompts: [newItem] },
      { prompts: [current] },
      '2.1.300'
    );
    expect(prompts[0].identifierMap).toEqual(current.identifierMap);
    expect(prompts[0].version).toBe(oldItem.version);
  });
});

// 2.8.40 shipped tool-description-projects with one slot, the memory flag, as
// VAR_0. Promoting the upload-mode index ahead of it must not take that name.
describe('the shipped tool-description-projects names', () => {
  it('keeps VAR_0 on the memory flag and gives the index VAR_1', () => {
    const file = path.join(
      import.meta.dirname,
      '..',
      'data',
      'prompts',
      'prompts-2.1.294.json'
    );
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).prompts.find(
      x => x.id === 'tool-description-projects'
    );
    const nameAfter = tail => {
      const i = p.pieces.findIndex(s => s.endsWith(tail));
      expect(i).toBeGreaterThanOrEqual(0);
      return p.identifierMap[p.identifiers[i]];
    };
    expect(nameAfter('even for a file you have."}[')).toBe(
      'TOOL_DESCRIPTION_PROJECTS_VAR_1'
    );
    expect(nameAfter('remove them from the project in claude.ai.\n${')).toBe(
      'TOOL_DESCRIPTION_PROJECTS_VAR_0'
    );
  });
});
