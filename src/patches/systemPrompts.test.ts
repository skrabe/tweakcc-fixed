import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySystemPrompts } from './systemPrompts';
import * as promptSync from '../systemPromptSync';
import * as systemPromptHashIndex from '../systemPromptHashIndex';

vi.mock('../systemPromptSync', async () => {
  const actual = await vi.importActual('../systemPromptSync');
  return {
    ...actual,
    loadSystemPromptsWithRegex: vi.fn(),
    loadIdentifierMapUnion: vi.fn(),
  };
});

vi.mock('../systemPromptHashIndex', async () => {
  const actual = await vi.importActual('../systemPromptHashIndex');
  return {
    ...actual,
    setAppliedHashes: vi.fn(),
  };
});

function buildMockPromptData(
  overrides: {
    promptId?: string;
    prompt?: Partial<{
      name: string;
      description: string;
      ccVersion: string;
      contentLineOffset: number;
      variables: string[];
      content: string;
    }>;
    content?: string;
    regex?: string;
    getInterpolatedContent?: (match: RegExpMatchArray) => string;
    pieces?: string[];
    identifiers?: number[];
    identifierMap?: Record<string, string>;
  } = {}
) {
  const content = overrides.content;
  const hasExplicitFields =
    overrides.regex !== undefined ||
    overrides.getInterpolatedContent !== undefined ||
    overrides.pieces !== undefined;

  const derivedRegex =
    overrides.regex ?? (!hasExplicitFields && content ? content : '');
  const derivedGetInterpolatedContent =
    overrides.getInterpolatedContent ??
    (!hasExplicitFields && content ? () => content : () => '');
  const derivedPieces =
    overrides.pieces ?? (!hasExplicitFields && content ? [content] : []);

  const promptContent = overrides.prompt?.content ?? content ?? '';

  return {
    promptId: overrides.promptId ?? 'test-prompt',
    prompt: {
      name: 'Test Prompt',
      description: 'Test',
      ccVersion: '1.0.0',
      contentLineOffset: 0,
      variables: [],
      ...overrides.prompt,
      content: promptContent,
    },
    regex: derivedRegex,
    getInterpolatedContent: derivedGetInterpolatedContent,
    pieces: derivedPieces,
    identifiers: overrides.identifiers ?? [],
    identifierMap: overrides.identifierMap ?? {},
  };
}

function setupMocks(
  promptData: ReturnType<typeof buildMockPromptData>,
  hashBehavior?: Error
) {
  vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue([
    promptData,
  ]);
  if (hashBehavior instanceof Error) {
    vi.mocked(systemPromptHashIndex.setAppliedHashes).mockRejectedValue(
      hashBehavior
    );
  } else {
    vi.mocked(systemPromptHashIndex.setAppliedHashes).mockResolvedValue();
  }
}

describe('systemPrompts.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty union (no known human-names) → guard never skips.
    // Tests exercising the guard set their own union explicitly.
    vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(new Set());
  });

  describe('applySystemPrompts', () => {
    it('should correctly handle variables with double dollar signs ($$) in replacement', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: {
          variables: ['MAX_TIMEOUT'],
          content: 'Timeout: ${MAX_TIMEOUT()} ms',
        },
        regex: 'Timeout: ([\\w$]+)\\(\\) ms',
        getInterpolatedContent: (match: RegExpMatchArray) => {
          const capturedVar = match[1];
          return `Timeout: \${${capturedVar}()} ms`;
        },
        pieces: ['Timeout: ${', '()} ms'],
        identifiers: [1],
        identifierMap: { '1': 'MAX_TIMEOUT' },
      });

      setupMocks(mockPromptData);

      const cliContent = 'Timeout: J$$() ms';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('Timeout: ${J$$()} ms');
      expect(result.newContent).not.toBe('Timeout: ${J$()} ms');
    });

    it('should handle multiple occurrences of $$ correctly', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: {
          variables: ['VAR1', 'VAR2'],
          content: 'Values: ${VAR1} and ${VAR2}',
        },
        regex: 'Values: ([\\w$]+) and ([\\w$]+)',
        getInterpolatedContent: (match: RegExpMatchArray) => {
          const var1 = match[1];
          const var2 = match[2];
          return `Values: \${${var1}} and \${${var2}}`;
        },
        pieces: ['Values: ${', '} and ${', '}'],
        identifiers: [1, 2],
        identifierMap: { '1': 'VAR1', '2': 'VAR2' },
      });

      setupMocks(mockPromptData);

      const cliContent = 'Values: A$$ and B$$';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('Values: ${A$$} and ${B$$}');
      expect(result.newContent).not.toContain('${A$}');
      expect(result.newContent).not.toContain('${B$}');
    });

    it('should convert newlines to \\n for double-quoted string literals', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'Hello\nWorld' },
        regex: 'Hello(?:\n|\\\\n)World',
        getInterpolatedContent: () => 'Hello\nWorld',
        pieces: ['Hello\nWorld'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'description:"Hello\\nWorld"';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('description:"Hello\\nWorld"');
    });

    it('should convert CRLF line endings to \\n for double-quoted string literals (Windows)', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'Hello\r\nWorld' },
        regex: 'Hello(?:\n|\\\\n)World',
        getInterpolatedContent: () => 'Hello\r\nWorld',
        pieces: ['Hello\r\nWorld'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'description:"Hello\\nWorld"';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('description:"Hello\\nWorld"');
      expect(result.newContent).not.toMatch(/\r/);
    });

    it('should convert CRLF line endings to \\n for single-quoted string literals (Windows)', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'Hello\r\nWorld' },
        regex: 'Hello(?:\n|\\\\n)World',
        getInterpolatedContent: () => 'Hello\r\nWorld',
        pieces: ['Hello\r\nWorld'],
      });

      setupMocks(mockPromptData);

      const cliContent = "msg:'Hello\\nWorld'";

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe("msg:'Hello\\nWorld'");
      expect(result.newContent).not.toMatch(/\r/);
    });

    it('should normalize CRLF to LF for backtick template literals (Windows)', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'Hello\r\nWorld' },
        regex: 'Hello(?:\n|\\\\n)World',
        getInterpolatedContent: () => 'Hello\r\nWorld',
        pieces: ['Hello\r\nWorld'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'description:`Hello\nWorld`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('description:`Hello\nWorld`');
      expect(result.newContent).not.toMatch(/\r/);
    });

    it('should keep actual newlines for backtick template literals', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'Hello\nWorld' },
        regex: 'Hello(?:\n|\\\\n)World',
        getInterpolatedContent: () => 'Hello\nWorld',
        pieces: ['Hello\nWorld'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'description:`Hello\nWorld`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('description:`Hello\nWorld`');
    });

    it('should escape double quotes in double-quoted string literals', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Say "Hello"',
      });

      setupMocks(mockPromptData);

      const cliContent = 'msg:"Say "Hello""';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('msg:"Say \\"Hello\\""');
    });

    it('should escape backslashes before quotes to preserve literal backslash-quotes (#660)', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Say \\"Hello\\"',
        regex: 'Say \\\\"Hello\\\\"',
        getInterpolatedContent: () => 'Say \\"Hello\\"',
        pieces: ['Say \\"Hello\\"'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'msg:"Say \\"Hello\\""';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('msg:"Say \\\\\\"Hello\\\\\\""');
    });

    it('should auto-escape backticks in template literal context', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Choose the `subagent_type` based on needs',
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Choose the `subagent_type` based on needs`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(
        'desc:`Choose the \\`subagent_type\\` based on needs`'
      );
    });

    it('should skip prompt with applied:false when escapeDepthZeroBackticks returns incomplete', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'text ${unclosed backtick' },
        regex: 'text \\$\\{unclosed backtick',
        getInterpolatedContent: () => 'text ${unclosed backtick',
        pieces: ['text ${unclosed backtick'],
      });

      setupMocks(mockPromptData);
      const spy = vi
        .spyOn(promptSync, 'escapeDepthZeroBackticks')
        .mockReturnValue({
          content: 'partially escaped',
          incomplete: true,
        });

      const cliContent = 'desc:`text ${unclosed backtick`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(cliContent);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].applied).toBe(false);
      expect(result.results[0].details).toContain('incomplete');
      spy.mockRestore();
    });

    it('should skip when a single-word human-name placeholder (no underscore) leaks, via the identifierMap union', async () => {
      // ${VERSION} has no underscore, so the old ALL_CAPS_WITH_UNDERSCORE
      // grammar regex missed it. The union check catches it because VERSION is
      // a member of the leaf's identifierMap vocabulary.
      vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(
        new Set(['VERSION'])
      );
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'before ${VERSION} after' },
        regex: 'before \\$\\{VERSION\\} after',
        getInterpolatedContent: () => 'before ${VERSION} after',
        pieces: ['before ${VERSION} after'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`before ${VERSION} after`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(cliContent);
      expect(result.results[0].applied).toBe(false);
      expect(result.results[0].details).toContain('unresolved placeholder');
    });

    it('should skip prompt when an unescaped human-name placeholder leaks into a backtick literal', async () => {
      // The markdown references ${STALE_VAR_NAME} -- a human-name in the leaf's
      // identifierMap union but with no entry in THIS version's prompt data, so
      // getInterpolatedContent leaves it verbatim. Embedding it into a `${...}`
      // template-literal slot would ReferenceError at launch, so the guard skips
      // the prompt and keeps CC's original blob.
      vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(
        new Set(['STALE_VAR_NAME'])
      );
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'before ${STALE_VAR_NAME} after' },
        regex: 'before \\$\\{STALE_VAR_NAME\\} after',
        getInterpolatedContent: () => 'before ${STALE_VAR_NAME} after',
        pieces: ['before ${STALE_VAR_NAME} after'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`before ${STALE_VAR_NAME} after`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(cliContent);
      expect(result.results[0].applied).toBe(false);
      expect(result.results[0].details).toContain('unresolved placeholder');
    });

    it('should NOT skip an underscored ${NAME} that is not a human-name (real runtime binding, absent from the union)', async () => {
      // The old grammar regex flagged any ALL_CAPS_WITH_UNDERSCORE token,
      // false-positiving on a genuine runtime interpolation. The union check
      // only skips known human-names, so a real binding absent from the union
      // is applied normally.
      vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(
        new Set(['GLOB_TOOL_NAME'])
      );
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'wait ${MAX_RETRY_COUNT} ms then stop' },
        regex: 'wait \\$\\{MAX_RETRY_COUNT\\} ms then go',
        getInterpolatedContent: () => 'wait ${MAX_RETRY_COUNT} ms then stop',
        pieces: ['wait ${MAX_RETRY_COUNT} ms then go'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`wait ${MAX_RETRY_COUNT} ms then go`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.results[0].applied).toBe(true);
      expect(result.results[0].details ?? '').not.toContain(
        'unresolved placeholder'
      );
      expect(result.newContent).toBe(
        'desc:`wait ${MAX_RETRY_COUNT} ms then stop`'
      );
    });

    it('should NOT skip when an ALL_CAPS placeholder is backslash-escaped (literal env-var docs)', async () => {
      // `\${CLAUDE_PLUGIN_ROOT}`-style tokens are intentional literal text, not
      // interpolation slots. Even when the name IS a union member, the
      // backslash-escape (negative lookbehind) keeps the guard from flagging it
      // -- so the escape, not mere absence from the union, is what protects it.
      vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(
        new Set(['CLAUDE_PLUGIN_ROOT'])
      );
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'use \\${CLAUDE_PLUGIN_ROOT} now' },
        regex: 'use \\\\\\$\\{CLAUDE_PLUGIN_ROOT\\} here',
        getInterpolatedContent: () => 'use \\${CLAUDE_PLUGIN_ROOT} now',
        pieces: ['use \\${CLAUDE_PLUGIN_ROOT} here'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`use \\${CLAUDE_PLUGIN_ROOT} here`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      // Guard did NOT skip it: the escaped token is treated as literal text and
      // the override is applied (here, swapping "here" -> "now").
      expect(result.results[0].applied).toBe(true);
      expect(result.results[0].details ?? '').not.toContain(
        'unresolved placeholder'
      );
      expect(result.newContent).toBe('desc:`use \\${CLAUDE_PLUGIN_ROOT} now`');
    });

    it('should quietly skip a site whose placeholders resolve via a same-id sibling shape', async () => {
      // A multi-site prompt: one template-wrapper entry (slot 0 named) and one
      // plain-string entry, sharing one promptId and one .md. The .md is
      // authored against the wrapper shape, so at the plain site the
      // placeholder cannot resolve — injecting it would write
      // "${PEER_MESSAGE_HEADER}" as literal text into the binary (the
      // cross-session reminder corruption, 2.1.170). The plain entry must
      // skip and leave its site pristine, without the loud drift warning.
      vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(
        new Set(['PEER_MESSAGE_HEADER'])
      );
      const md = '${PEER_MESSAGE_HEADER}\nIMPORTANT: stay safe edited';
      const wrapperEntry = buildMockPromptData({
        promptId: 'peer-warning',
        prompt: { content: md },
        regex: '\\$\\{([\\w$]+)\\}\\nIMPORTANT: stay safe',
        getInterpolatedContent: m =>
          '${' + m[1] + '}\nIMPORTANT: stay safe edited',
        pieces: ['${', '}\nIMPORTANT: stay safe'],
        identifiers: [0],
        identifierMap: { '0': 'PEER_MESSAGE_HEADER' },
      });
      const plainEntry = buildMockPromptData({
        promptId: 'peer-warning',
        prompt: { content: md },
        regex: 'IMPORTANT: stay safe',
        getInterpolatedContent: () => md,
        pieces: ['IMPORTANT: stay safe'],
      });
      vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue([
        wrapperEntry,
        plainEntry,
      ]);
      vi.mocked(systemPromptHashIndex.setAppliedHashes).mockResolvedValue();

      const cliContent =
        'a:`${q9}\nIMPORTANT: stay safe`;b:"IMPORTANT: stay safe"';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      // Wrapper site applied with the real var; plain site left pristine.
      expect(result.newContent).toBe(
        'a:`${q9}\nIMPORTANT: stay safe edited`;b:"IMPORTANT: stay safe"'
      );
      expect(result.results[0].applied).toBe(true);
      expect(result.results[1].applied).toBe(false);
      expect(result.results[1].skipped).toBe(true);
      expect(result.results[1].details ?? '').not.toContain(
        'unresolved placeholder'
      );
    });

    it('should still pass an inert union-name literal through in quote context when no sibling resolves it', async () => {
      // data-anthropic-cli class: the .md holds an unescaped ${VERSION} that is
      // a union member, but the prompt is a quoted string where the token is
      // inert literal text — and no same-id sibling names it. Behavior must
      // stay inject-as-is, not skip.
      vi.mocked(promptSync.loadIdentifierMapUnion).mockResolvedValue(
        new Set(['VERSION'])
      );
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'run with ${VERSION} flag now' },
        regex: 'run with \\$\\{VERSION\\} flag',
        getInterpolatedContent: () => 'run with ${VERSION} flag now',
        pieces: ['run with ${VERSION} flag'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'd:"run with ${VERSION} flag"';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.results[0].applied).toBe(true);
      expect(result.newContent).toBe('d:"run with ${VERSION} flag now"');
    });

    it('should escape non-ASCII after backslash-doubling in quote contexts (no \\\\uXXXX double-escape)', async () => {
      // Native binaries store non-ASCII as \uXXXX escapes. The escape used to
      // run inside getInterpolatedContent, BEFORE the quote-context
      // backslash-doubling — which doubled the escape's own backslash and
      // shipped literal `\\u2014` text to the model at every quote-context
      // site containing an em-dash.
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'left — right edited' },
        regex: 'left \\\\u2014 right',
        getInterpolatedContent: () => 'left — right edited',
        pieces: ['left — right'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'd:"left \\u2014 right"';

      const result = await applySystemPrompts(cliContent, '1.0.0', true);

      expect(result.newContent).toBe('d:"left \\u2014 right edited"');
      expect(result.newContent).not.toContain('\\\\u2014');
    });

    it('should make an unchanged non-ASCII override a byte-identical no-op in quote contexts', async () => {
      // An override whose body equals pristine must splice back the exact
      // original bytes — the double-escape bug made even no-op applies mutate
      // every \uXXXX sequence.
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'left — right' },
        regex: 'left \\\\u2014 right',
        getInterpolatedContent: () => 'left — right',
        pieces: ['left — right'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'd:"left \\u2014 right"';

      const result = await applySystemPrompts(cliContent, '1.0.0', true);

      expect(result.newContent).toBe(cliContent);
      expect(result.results[0].applied).toBe(false);
    });

    it('should auto-escape multiple backticks in template literal context', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Use `foo` and `bar` for config',
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Use `foo` and `bar` for config`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(
        'desc:`Use \\`foo\\` and \\`bar\\` for config`'
      );
    });

    it('should preserve already-escaped backticks in template literal context (#660)', async () => {
      // tweakcc's markdown files store prompt content in JS-source-escaped form
      // (they are extracted from cli.js template literals, where each `\\`` is
      // already an escape sequence). When re-embedded into a template literal,
      // the content must NOT be re-escaped — escapeDepthZeroBackticks leaves
      // already-escaped backticks alone. Backslash-doubling is intentionally
      // scoped to `"` / `'` delimiters only; doubling here would break valid
      // cli.js template literals.
      const mockPromptData = buildMockPromptData({
        content: 'Use \\`foo\\` for config',
        regex: 'Use \\\\`foo\\\\` for config',
        getInterpolatedContent: () => 'Use \\`foo\\` for config',
        pieces: ['Use \\`foo\\` for config'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Use \\`foo\\` for config`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('desc:`Use \\`foo\\` for config`');
    });

    it('should auto-escape backticks adjacent to template expressions', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Value: `${x}`',
        regex: 'Value: `\\$\\{x\\}`',
        getInterpolatedContent: () => 'Value: `${x}`',
        pieces: ['Value: `${x}`'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Value: `${x}``';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('desc:`Value: \\`${x}\\``');
    });

    it('should auto-escape bare backticks while preserving already-escaped backticks (#660)', async () => {
      // Mixed content: `\\`foo\\`` is already in JS-source-escaped form and
      // must pass through unchanged; bare `bar` has unescaped backticks that
      // escapeDepthZeroBackticks must escape to keep the surrounding template
      // literal parseable.
      const mockPromptData = buildMockPromptData({
        content: 'Use \\`foo\\` and `bar` for config',
        regex: 'Use \\\\`foo\\\\` and `bar` for config',
        getInterpolatedContent: () => 'Use \\`foo\\` and `bar` for config',
        pieces: ['Use \\`foo\\` and `bar` for config'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Use \\`foo\\` and `bar` for config`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(
        'desc:`Use \\`foo\\` and \\`bar\\` for config`'
      );
    });

    it('should auto-escape backticks at start and end of content', async () => {
      const mockPromptData = buildMockPromptData({
        content: '`code`',
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:``code``';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('desc:`\\`code\\``');
    });

    it('should auto-escape consecutive backticks individually', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Use ```code``` blocks',
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Use ```code``` blocks`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(
        'desc:`Use \\`\\`\\`code\\`\\`\\` blocks`'
      );
    });

    it('should preserve backticks inside interpolation expressions', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Run `cmd` then ${cond?`a`:`b`}',
        regex: 'Run `cmd` then \\$\\{cond\\?`a`:`b`\\}',
        getInterpolatedContent: () => 'Run `cmd` then ${cond?`a`:`b`}',
        pieces: ['Run `cmd` then ${cond?`a`:`b`}'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Run `cmd` then ${cond?`a`:`b`}`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe(
        'desc:`Run \\`cmd\\` then ${cond?`a`:`b`}`'
      );
    });

    it('should escape depth-0 backticks but preserve interpolation backticks', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Use `x` and ${c?`a`:`b`}',
        regex: 'Use `x` and \\$\\{c\\?`a`:`b`\\}',
        getInterpolatedContent: () => 'Use `x` and ${c?`a`:`b`}',
        pieces: ['Use `x` and ${c?`a`:`b`}'],
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Use `x` and ${c?`a`:`b`}`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('desc:`Use \\`x\\` and ${c?`a`:`b`}`');
    });

    it('should escape single quotes in single-quoted string literals', async () => {
      const mockPromptData = buildMockPromptData({
        content: "It's working",
      });

      setupMocks(mockPromptData);

      const cliContent = "msg:'It's working'";

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe("msg:'It\\'s working'");
    });

    it('should escape backslashes before single quotes to preserve literal backslash-quotes (#660)', async () => {
      const mockPromptData = buildMockPromptData({
        content: "It\\'s working",
        regex: "It\\\\'s working",
        getInterpolatedContent: () => "It\\'s working",
        pieces: ["It\\'s working"],
      });

      setupMocks(mockPromptData);

      const cliContent = "msg:'It\\'s working'";

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe("msg:'It\\\\\\'s working'");
    });

    it('should set applied:true when auto-escape changes content even if char delta is 0', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Use `x` here',
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:`Use `x` here`';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toBe('desc:`Use \\`x\\` here`');
      expect(result.results[0].applied).toBe(true);
    });

    it('should surface hash persistence failure in result details', async () => {
      const mockPromptData = buildMockPromptData({
        prompt: { content: 'New longer content here' },
        regex: 'Original text',
        getInterpolatedContent: () => 'New longer content here',
        pieces: ['Original text'],
      });

      setupMocks(mockPromptData, new Error('Storage failure'));

      const cliContent = 'desc:"Original text"';

      const result = await applySystemPrompts(cliContent, '1.0.0', false);

      expect(result.newContent).toContain('New longer content here');
      expect(result.results[0].failed).toBe(true);
      expect(result.results[0].details).toContain('hash storage failed');
    });

    it('should persist applied hashes in one batch', async () => {
      const firstPrompt = buildMockPromptData({
        promptId: 'first-prompt',
        prompt: { content: 'First replacement' },
        regex: 'First original',
        getInterpolatedContent: () => 'First replacement',
        pieces: ['First original'],
      });
      const secondPrompt = buildMockPromptData({
        promptId: 'second-prompt',
        prompt: { content: 'Second replacement' },
        regex: 'Second original',
        getInterpolatedContent: () => 'Second replacement',
        pieces: ['Second original'],
      });

      vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue([
        firstPrompt,
        secondPrompt,
      ]);
      vi.mocked(systemPromptHashIndex.setAppliedHashes).mockResolvedValue();

      await applySystemPrompts(
        'one:"First original";two:"Second original"',
        '1.0.0',
        false
      );

      expect(systemPromptHashIndex.setAppliedHashes).toHaveBeenCalledTimes(1);
      expect(systemPromptHashIndex.setAppliedHashes).toHaveBeenCalledWith({
        'first-prompt':
          systemPromptHashIndex.computeMD5Hash('First replacement'),
        'second-prompt':
          systemPromptHashIndex.computeMD5Hash('Second replacement'),
      });
    });

    it('should skip prompts not in patchFilter', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Hello World',
      });

      setupMocks(mockPromptData);

      const cliContent = 'desc:"Hello World"';

      const result = await applySystemPrompts(cliContent, '1.0.0', false, [
        'other-id',
      ]);

      expect(result.newContent).toBe(cliContent);
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].applied).toBe(false);
    });

    // Root cause B: a named prompt whose region was consumed (replaced) by an
    // earlier inline-blob/reminder override this apply. Its regex matched the
    // pristine snapshot but not the current (post-splice) binary → silent skip,
    // no "Could not find" noise.
    it('silently skips a prompt clobbered by an earlier splice (matched pristine, not current)', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'Tools are executed in a permission mode',
      });
      setupMocks(mockPromptData);

      // pristineContent contains the text; current content does NOT (an earlier
      // inline-blob override already replaced that region).
      const pristine = 'arr=["Tools are executed in a permission mode","x"]';
      const current = 'arr=["LOBOTOMIZED bullet","x"]';

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await applySystemPrompts(
        current,
        '1.0.0',
        false,
        null,
        pristine
      );
      const warned = logSpy.mock.calls
        .flat()
        .some(a => typeof a === 'string' && a.includes('Could not find'));
      logSpy.mockRestore();

      expect(warned).toBe(false);
      expect(result.newContent).toBe(current);
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].applied).toBe(false);
    });

    // The contrast case: genuine drift (the regex matched NEITHER the pristine
    // snapshot nor the current binary) still surfaces a "Could not find"
    // warning so the owning override can be realigned.
    it('still warns on genuine drift (matched neither pristine nor current)', async () => {
      const mockPromptData = buildMockPromptData({
        content: 'This text is nowhere in the binary',
      });
      setupMocks(mockPromptData);

      const pristine = 'arr=["something else entirely","x"]';
      const current = 'arr=["something else entirely","x"]';

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await applySystemPrompts(
        current,
        '1.0.0',
        false,
        null,
        pristine
      );
      const warned = logSpy.mock.calls
        .flat()
        .some(a => typeof a === 'string' && a.includes('Could not find'));
      logSpy.mockRestore();

      expect(warned).toBe(true);
      expect(result.newContent).toBe(current);
    });

    // Multi-site disambiguation. Exactly one standalone match is preferred.
    // When that fails we take allMatches[0], which is NOT arbitrary: 124 prompt
    // ids occupy multiple binary sites (327 catalogue entries), each entry
    // splicing one site. After a splice the content changes, so the next
    // entry's regex matches the remaining sites and [0] is the next unpatched
    // one. Making ambiguity fail instead broke 124 prompts / 302 sites.
    describe('multi-site disambiguation', () => {
      const buildData = () =>
        buildMockPromptData({
          prompt: { content: 'HOOKS OVERRIDE' },
          regex: 'never skip hooks',
          getInterpolatedContent: () => 'HOOKS OVERRIDE',
          pieces: ['never skip hooks'],
        });

      const applyWithSpy = async (cliContent: string) => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await applySystemPrompts(cliContent, '1.0.0', false);
        const errors = errSpy.mock.calls
          .flat()
          .filter((a): a is string => typeof a === 'string');
        errSpy.mockRestore();
        return { result, errors };
      };

      it('splices the single standalone match, not the first occurrence', async () => {
        setupMocks(buildData());
        const { result, errors } = await applyWithSpy(
          'x="pre never skip hooks post";y="never skip hooks";'
        );

        expect(result.newContent).toBe(
          'x="pre never skip hooks post";y="HOOKS OVERRIDE";'
        );
        expect(result.results[0].applied).toBe(true);
        expect(errors).toEqual([]);
      });

      it('falls back to the first site when none is standalone', async () => {
        setupMocks(buildData());
        const { result, errors } = await applyWithSpy(
          'x="pre never skip hooks post";y="never skip hooks now";'
        );

        expect(result.newContent).toBe(
          'x="pre HOOKS OVERRIDE post";y="never skip hooks now";'
        );
        expect(result.results[0].applied).toBe(true);
        expect(errors).toEqual([]);
      });

      // The multi-site mechanism: each catalogue entry consumes the next
      // unpatched site, so several standalone matches must NOT fail.
      it('consumes the first site when several are standalone', async () => {
        setupMocks(buildData());
        const { result, errors } = await applyWithSpy(
          'x="never skip hooks";y="never skip hooks";'
        );

        expect(result.newContent).toBe(
          'x="HOOKS OVERRIDE";y="never skip hooks";'
        );
        expect(result.results[0].applied).toBe(true);
        expect(errors).toEqual([]);
      });

      it('consumes two sites for two catalogue entries sharing one regex', async () => {
        const first = buildData();
        const second = buildMockPromptData({
          promptId: first.promptId,
          prompt: { content: 'SECOND OVERRIDE' },
          regex: first.regex,
          getInterpolatedContent: () => 'SECOND OVERRIDE',
          pieces: first.pieces,
        });
        vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue([
          first,
          second,
        ]);
        vi.mocked(systemPromptHashIndex.setAppliedHashes).mockResolvedValue();

        const { result, errors } = await applyWithSpy(
          'x="never skip hooks";y="never skip hooks";'
        );

        expect(result.newContent).toBe(
          'x="HOOKS OVERRIDE";y="SECOND OVERRIDE";'
        );
        expect(result.results.map(item => item.applied)).toEqual([true, true]);
        expect(errors).toEqual([]);
      });

      // A multi-site prompt must not disturb its neighbours.
      it('applies both a multi-site prompt and an unrelated one', async () => {
        const ambiguous = buildData();
        const other = buildMockPromptData({
          promptId: 'other-prompt',
          prompt: { name: 'Other Prompt', content: 'OTHER OVERRIDE' },
          regex: 'unique target text',
          getInterpolatedContent: () => 'OTHER OVERRIDE',
          pieces: ['unique target text'],
        });
        vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue([
          ambiguous,
          other,
        ]);
        vi.mocked(systemPromptHashIndex.setAppliedHashes).mockResolvedValue();

        const { result } = await applyWithSpy(
          'x="never skip hooks";y="never skip hooks";z="unique target text";'
        );

        expect(result.results[0].applied).toBe(true);
        expect(result.results[1].applied).toBe(true);
        expect(result.newContent).toContain('x="HOOKS OVERRIDE"');
        expect(result.newContent).toContain('z="OTHER OVERRIDE"');
      });
    });
  });
});
