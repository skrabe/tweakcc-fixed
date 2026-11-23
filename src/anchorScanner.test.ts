import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractClaudeJsFromNativeInstallation } from './nativeInstallation';
import {
  AnchorIndex,
  MAX_ANCHOR_OCCURRENCES,
  promptAnchorInfo,
} from './systemPromptPieceMatcher';
import { extractBuildTime } from './systemPromptSites';

const PAIR = '\u{1F600}';

const oracle = (text: string, anchor: string): number[] | null => {
  const found: number[] = [];
  for (
    let at = text.indexOf(anchor);
    at !== -1;
    at = text.indexOf(anchor, at + 1)
  ) {
    found.push(at);
  }
  return found.length > MAX_ANCHOR_OCCURRENCES ? null : found;
};

const indexOf = (anchors: string[]): AnchorIndex => {
  const index = new AnchorIndex();
  for (const anchor of anchors) index.add(anchor);
  return index;
};

const sorted = (
  map: Map<string, number[] | null>
): Array<[string, number[] | null]> =>
  [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe('Latin-1 byte anchor scanner', () => {
  const anchors = [
    'alpha bravo charlie',
    'Apha bravo charlie',
    'Łpha bravo charlie',
    'Settings → This computer',
    'x→yz',
    'echo',
    'ab',
    'count oscar papa',
  ];
  const text = [
    PAIR,
    'alpha bravo charlie',
    'Łpha bravo charlie',
    'Apha bravo charlie',
    PAIR,
    'Settings → This computer',
    'Settings \u0092 This computer',
    'x→yz x\u0092yz',
    'echo',
    PAIR,
    'ab',
    'count oscar papa;'.repeat(MAX_ANCHOR_OCCURRENCES + 1),
    'alpha bravo charlie',
    PAIR,
  ].join('|');

  it('finds exactly the char-code scanner and indexOf occurrences', () => {
    const index = indexOf(anchors);
    const scanned = index.scan(text);
    expect(sorted(scanned)).toEqual(sorted(index.scanByCharCodes(text)));
    for (const anchor of anchors) {
      expect(scanned.has(anchor) ? scanned.get(anchor) : [], anchor).toEqual(
        oracle(text, anchor)
      );
    }
    const firstPair = text.indexOf(PAIR);
    expect(scanned.get('alpha bravo charlie')).toHaveLength(2);
    expect(
      scanned.get('alpha bravo charlie')!.every(at => at > firstPair)
    ).toBe(true);
    expect(scanned.get('Apha bravo charlie')).toHaveLength(1);
    expect(scanned.get('Łpha bravo charlie')).toHaveLength(1);
    expect(scanned.get('Settings → This computer')).toHaveLength(1);
    expect(scanned.get('x→yz')).toHaveLength(1);
    expect(scanned.get('count oscar papa')).toBeNull();
  });

  it('agrees on every window of a splice-sized slice and after removal', () => {
    const index = indexOf(anchors);
    for (let start = 0; start < 120; start += 7) {
      const slice = text.slice(start, start + 90);
      expect(sorted(index.scan(slice)), `slice ${start}`).toEqual(
        sorted(index.scanByCharCodes(slice))
      );
    }
    index.remove('Apha bravo charlie');
    index.remove('x→yz');
    const scanned = index.scan(text);
    expect(scanned.has('Apha bravo charlie')).toBe(false);
    expect(scanned.has('x→yz')).toBe(false);
    expect(sorted(scanned)).toEqual(sorted(index.scanByCharCodes(text)));
  });
});

const BUNDLES = (process.env.TWEAKCC_ANCHOR_SCAN_BUNDLES ?? '')
  .split(',')
  .filter(Boolean);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bundleText = (file: string): string => {
  if (file.endsWith('.js')) return fs.readFileSync(file, 'utf8');
  const { data, error } = extractClaudeJsFromNativeInstallation(file);
  if (!data) throw new Error(`cannot extract ${file}: ${error}`);
  return data.toString('utf8');
};

const catalogueAnchors = (content: string, version: string): string[] => {
  const strings = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'data', 'prompts', `prompts-${version}.json`),
      'utf8'
    )
  ) as { prompts: Array<{ pieces: string[] }> };
  const buildTime = extractBuildTime(content);
  const anchors = new Set<string>();
  for (const prompt of strings.prompts) {
    const anchor = promptAnchorInfo({
      regex: '',
      pieces: prompt.pieces,
      version,
      buildTime,
    }).anchor;
    if (anchor) anchors.add(anchor);
  }
  return [...anchors];
};

const yieldToRunner = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve));

const widened = (content: string): string => {
  const parts: string[] = [];
  for (let at = 0; at < content.length; at += 65_536) {
    parts.push(content.slice(at, at + 65_536).replace(/A/, 'Ł'), PAIR);
  }
  return parts.join('');
};

describe.skipIf(BUNDLES.length === 0)(
  'real-bundle anchor scan differential (TWEAKCC_ANCHOR_SCAN_BUNDLES)',
  () => {
    it.each(BUNDLES)(
      '%s',
      async file => {
        const version = process.env.TWEAKCC_ANCHOR_SCAN_VERSION ?? '2.1.330';
        const pristine = bundleText(file);
        await yieldToRunner();
        const anchors = catalogueAnchors(pristine, version);
        const index = indexOf(anchors);
        for (const [stage, content] of [
          ['pristine', pristine],
          ['two-byte', widened(pristine)],
        ] as const) {
          const initial = (): Map<string, number[] | null> =>
            new Map(anchors.map(anchor => [anchor, []]));
          let started = performance.now();
          const scanned = index.scan(content, initial());
          const fast = performance.now() - started;
          await yieldToRunner();
          started = performance.now();
          const reference = index.scanByCharCodes(content, initial());
          const old = performance.now() - started;
          await yieldToRunner();
          expect(sorted(scanned)).toEqual(sorted(reference));
          const positions = [...scanned.values()].reduce(
            (sum, list) => sum + (list?.length ?? 0),
            0
          );
          const capped = [...scanned.values()].filter(v => v === null).length;
          expect(positions).toBeGreaterThan(0);
          process.stdout.write(
            `${path.basename(file)} ${stage}: ${content.length} units, ` +
              `${anchors.length} anchors, ${positions} occurrences, ` +
              `${capped} capped; char-code ${old.toFixed(0)} ms, ` +
              `latin1 ${fast.toFixed(0)} ms\n`
          );
        }
      },
      600_000
    );
  }
);
