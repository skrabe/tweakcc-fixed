import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import {
  generateMarkdownFromPrompt,
  stringifyPromptMarkdown,
  type StringsPrompt,
} from './systemPromptSync';

const OPTS = { delimiters: ['<!--', '-->'] as [string, string] };

const promptWith = (pieces: string[]): StringsPrompt =>
  ({
    id: 'skill-artifact-report-html-template',
    name: 'Skill: Artifact report HTML template',
    description: 'Model-facing template.html scaffold for the report artifact.',
    version: '2.1.206',
    pieces,
    identifiers: [],
    identifierMap: {},
  }) as unknown as StringsPrompt;

describe('generateMarkdownFromPrompt with an HTML-comment body', () => {
  // CC 2.1.206 shipped artifact `template.html` fragments whose first line is
  // `<!-- Artifact-tool body fragment ... -->`. gray-matter's stringify parsed
  // that as the file's front-matter and threw `engine "..." is not registered`,
  // which aborted the whole sync loop.
  const body =
    '<!-- Artifact-tool body fragment — no <!DOCTYPE> wrapper. -->\n' +
    '<title>Report</title>\n' +
    '<!-- SLOT: masthead -->\n';

  it('does not throw when the body starts with the front-matter delimiter', () => {
    expect(() => generateMarkdownFromPrompt(promptWith([body]))).not.toThrow();
  });

  it('round-trips: front-matter parses and the body survives verbatim', () => {
    const md = generateMarkdownFromPrompt(promptWith([body]));
    const parsed = matter(md, OPTS);
    expect(parsed.data.name).toBe('Skill: Artifact report HTML template');
    expect(parsed.data.ccVersion).toBe('2.1.206');
    expect(parsed.content.trim()).toBe(body.trim());
  });

  it('emits byte-identical output for an ordinary body', () => {
    const plain = 'Just a normal prompt body.';
    const md = generateMarkdownFromPrompt(promptWith([plain]));
    const viaMatter = matter.stringify(
      plain,
      {
        name: 'Skill: Artifact report HTML template',
        description:
          'Model-facing template.html scaffold for the report artifact.',
        ccVersion: '2.1.206',
      },
      OPTS
    );
    expect(md).toBe(viaMatter);
  });

  // The update path (updateVariables) re-stringifies the PARSED content of an
  // existing file, which is where the second wave of failures came from.
  it('re-stringifies an already-written HTML-comment body without throwing', () => {
    const md = generateMarkdownFromPrompt(promptWith([body]));
    const parsed = matter(md, OPTS);
    expect(() =>
      stringifyPromptMarkdown(parsed.content, {
        ...parsed.data,
        variables: ['A', 'B'],
      })
    ).not.toThrow();
    const round = matter(
      stringifyPromptMarkdown(parsed.content, {
        ...parsed.data,
        variables: ['A', 'B'],
      }),
      OPTS
    );
    expect(round.data.variables).toEqual(['A', 'B']);
    expect(round.content.trim()).toBe(body.trim());
  });

  it('matches gray-matter trailing-newline handling (idempotent rewrites)', () => {
    const data = { name: 'N', description: 'D', ccVersion: '1.0.0' };
    for (const b of ['BODY', 'BODY\n', 'BODY\n\n', '\nBODY', '']) {
      expect(stringifyPromptMarkdown(b, data)).toBe(
        matter.stringify(b, data, OPTS)
      );
    }
  });
});
