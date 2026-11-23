import { readFileSync } from 'node:fs';
import { parseExpressionAt } from 'acorn';
import { describe, expect, it } from 'vitest';
import { writeEmptyEnvironment } from './emptyEnvironment';
import {
  writeFffInstructionHygiene,
  writeFffInstructions,
} from './fffInstructions';

const pristinePath = process.env.TWEAKCC_PLACEMENT_PRISTINE;

describe.skipIf(!pristinePath)(
  'FFF placement on the selected pristine bundle',
  () => {
    it('matches the real API, context, serializer, and environment boundaries idempotently', () => {
      const original = readFileSync(pristinePath!, 'utf8');
      const clean = writeFffInstructionHygiene(original);
      expect(clean).not.toBeNull();
      expect(writeFffInstructionHygiene(clean!)).toBe(clean);
      const instructed = writeFffInstructions(clean!);
      expect(instructed).not.toBeNull();
      expect(writeFffInstructions(instructed!)).toBe(instructed);
      expect(writeFffInstructionHygiene(instructed!)).toBe(instructed);
      const patched = writeEmptyEnvironment(instructed!);
      expect(patched).not.toBeNull();
      expect(writeEmptyEnvironment(patched!)).toBe(patched);
      expect(
        patched!.match(/description:\(function __tweakccFffDescription\(/g)
      ).toHaveLength(1);
      expect(
        patched!.match(/function __tweakccRecordedPrompt\(/g)
      ).toHaveLength(2);
    });

    it('runs the real environment composer with blank overrides and preserves its nonempty branches', () => {
      const original = readFileSync(pristinePath!, 'utf8');
      const sites = [
        ...original.matchAll(
          /;return\[([$\w]+),\.\.\.([$\w]+)\(([$\w]+)\)\]\.join\(`\n`\)/g
        ),
      ].filter(match =>
        new RegExp(
          `(?:var |[,;])${match[1].replace(/\$/g, '\\$')}="# Environment"[,;]`
        ).test(original)
      );
      expect(sites).toHaveLength(1);
      const site = sites[0];
      const start = original.lastIndexOf('function ', site.index);
      const node = parseExpressionAt(original, start, {
        ecmaVersion: 'latest',
      });
      const composer = original.slice(start, node.end);
      const header =
        /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=\[([$\w]+)\(/.exec(
          composer
        )!;
      expect(header).not.toBeNull();
      const catalog = JSON.parse(
        readFileSync(
          new URL('../../data/prompts/prompts-2.1.317.json', import.meta.url),
          'utf8'
        )
      ) as {
        prompts: { id: string; pieces: string[] }[];
      };
      let blank = composer;
      for (const id of [
        'system-prompt-claude-code-cli-availability',
        'system-prompt-fast-mode-environment-note',
      ]) {
        const fragment = JSON.stringify(
          catalog.prompts.find(prompt => prompt.id === id)!.pieces[0]
        );
        expect(blank).toContain(fragment);
        blank = blank.replace(fragment, '""');
      }
      const declaration = `var ${site[1]}="# Environment";`;
      const make = (source: string, roster: string) =>
        new Function(
          site[2],
          header[6],
          declaration + source + `;return ${header[1]};`
        )(
          (parts: string[]) => parts.map(part => ' - ' + part),
          () => roster
        ) as (models: unknown[], fast: boolean, lean: boolean) => string;
      const patchedBlank = writeEmptyEnvironment(declaration + blank)!;
      expect(patchedBlank).not.toBeNull();
      expect(make(blank, '')([], false, false)).toBe(
        '# Environment\n - \n - \n - '
      );
      expect(make(patchedBlank, '')([], false, false)).toBe('');
      expect(make(patchedBlank, '')([], true, true)).toBe('');
      for (const fast of [false, true]) {
        for (const lean of [false, true]) {
          for (const source of [composer, blank]) {
            const patched = writeEmptyEnvironment(declaration + source)!;
            expect(make(patched, 'Real model roster.')([], fast, lean)).toBe(
              make(source, 'Real model roster.')([], fast, lean)
            );
          }
        }
      }
    });
  }
);
