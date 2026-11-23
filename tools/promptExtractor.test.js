import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const extractStrings = require('./promptExtractor.js');
const {
  leadShowsModelFacingContext,
  leadShowsDropContext,
  leadShowsExceptionContext,
  contentIsModelFacingShortPrompt,
  validateInput,
  ADMIT_FLOOR,
} = extractStrings;

// These tests lock the BELOW-FLOOR capture rules with SYNTHETIC inputs, so they
// stay valid across CC version bumps (they never depend on a specific cli.js).
// The signals are stable JS keywords / JSON-schema keys / Anthropic-controlled
// property names — never bundler-minified identifiers — which is what makes the
// extractor's "capture everything the model sees" behavior battleproof.

describe('promptExtractor below-floor capture', () => {
  describe('leadShowsModelFacingContext (stable model-facing emission sites)', () => {
    it('captures JSON-schema tool params {type,description}', () => {
      expect(leadShowsModelFacingContext('{type:"string",description:')).toBe(
        true
      );
      expect(
        leadShowsModelFacingContext('{type:"number",minimum:1,description:')
      ).toBe(true);
    });
    it('captures tool/agent/skill definitions {name,...,description}', () => {
      expect(leadShowsModelFacingContext('[{name:Pz1,description:')).toBe(true);
      expect(
        leadShowsModelFacingContext('{name:"Grep",inputSchema:x,description:')
      ).toBe(true);
    });
    it('captures descriptionForModel, tool-result text, whenToUse', () => {
      expect(leadShowsModelFacingContext('descriptionForModel:')).toBe(true);
      expect(leadShowsModelFacingContext('{type:"text",text:')).toBe(true);
      expect(leadShowsModelFacingContext('whenToUse:')).toBe(true);
    });
    it('does NOT fire on a bare/unpaired description: or arbitrary calls', () => {
      expect(leadShowsModelFacingContext('config={description:')).toBe(false);
      expect(leadShowsModelFacingContext('foo(')).toBe(false);
      expect(leadShowsModelFacingContext('x = ')).toBe(false);
    });
  });

  describe('leadShowsDropContext (stable non-model-facing emission sites)', () => {
    it('drops console + stderr/stdout writes', () => {
      expect(leadShowsDropContext('console.error(')).toBe(true);
      expect(leadShowsDropContext('console.log(')).toBe(true);
      expect(leadShowsDropContext('process.stderr.write(')).toBe(true);
    });
    it('drops React/Ink children and CLI --help builders', () => {
      expect(
        leadShowsDropContext('wA.createElement(dP,{color:"warning"},')
      ).toBe(true);
      expect(leadShowsDropContext('Y.jsx(T,{dimColor:!0,children:')).toBe(true);
      expect(leadShowsDropContext('.option(')).toBe(true);
      expect(leadShowsDropContext('.command(')).toBe(true);
    });
    it('no longer drops exception sites — their errors can be tool_results', () => {
      expect(leadShowsDropContext('throw new Error(')).toBe(false);
      expect(leadShowsDropContext('throw new ndH(')).toBe(false);
      expect(leadShowsDropContext('super(')).toBe(false);
      expect(leadShowsDropContext('Promise.reject(new Error(')).toBe(false);
    });
    it('does NOT fire on model-facing sites', () => {
      expect(leadShowsDropContext('{type:"string",description:')).toBe(false);
      expect(leadShowsDropContext('{name:X,description:')).toBe(false);
      expect(leadShowsDropContext('return ')).toBe(false);
    });
  });

  describe('leadShowsExceptionContext (keyword-anchored, never a minified name)', () => {
    it('recognises throw / new XError( / super( / Promise.reject( / zod refine', () => {
      expect(leadShowsExceptionContext('throw new Error(')).toBe(true);
      expect(leadShowsExceptionContext('throw new ndH(')).toBe(true);
      expect(leadShowsExceptionContext('throw Z(')).toBe(true);
      expect(leadShowsExceptionContext('throw ')).toBe(true);
      expect(leadShowsExceptionContext('x=new TypeError(')).toBe(true);
      expect(leadShowsExceptionContext('constructor(e){super(')).toBe(true);
      expect(leadShowsExceptionContext('return Promise.reject(new Q(')).toBe(
        true
      );
      expect(leadShowsExceptionContext('.refine(e=>e.length>0,{message:')).toBe(
        true
      );
    });
    it('does not fire on ordinary sites', () => {
      expect(leadShowsExceptionContext('return ')).toBe(false);
      expect(leadShowsExceptionContext('{type:"text",text:')).toBe(false);
      expect(leadShowsExceptionContext('console.error(')).toBe(false);
    });
  });

  describe('contentIsModelFacingShortPrompt', () => {
    it('captures a real <system-reminder> block but not a prose mention', () => {
      expect(
        contentIsModelFacingShortPrompt(
          '<system-reminder>\nDo X.\n</system-reminder>'
        )
      ).toBe(true);
      expect(
        contentIsModelFacingShortPrompt(
          'Agent types are listed in <system-reminder> messages.'
        )
      ).toBe(false);
    });
  });

  describe('validateInput floor + bypass', () => {
    it('rejects unsignalled strings below ADMIT_FLOOR', () => {
      expect(validateInput('too short', ADMIT_FLOOR)).toBe(false);
    });
    it('bypassQuality admits short single-sentence tool descriptions', () => {
      // No "you/must/should" + single sentence -> would fail prose-quality gates,
      // but a model-facing lead signal sets bypassQuality.
      const shortToolDesc = 'The symbol name to search for in the workspace.';
      expect(validateInput(shortToolDesc, ADMIT_FLOOR)).toBe(false);
      expect(validateInput(shortToolDesc, 1, { bypassQuality: true })).toBe(
        true
      );
    });
  });

  describe('end-to-end extractStrings on a synthetic snippet', () => {
    const extract = code => {
      const f = path.join(
        os.tmpdir(),
        `pe-test-${process.pid}-${Math.random().toString(36).slice(2)}.js`
      );
      fs.writeFileSync(f, code);
      try {
        const r = extractStrings(f);
        return {
          bodies: r.prompts.map(p =>
            (p.pieces || []).filter(x => typeof x === 'string').join('')
          ),
          candidates: r.gateCandidates.map(c => c.body),
        };
      } finally {
        fs.unlinkSync(f);
      }
    };
    const run = code => extract(code).bodies;

    it('captures a model-facing JSON-schema param below the old 500 floor', () => {
      const desc =
        'The complete question to ask the user. Should be clear and specific.';
      const bodies = run(
        `var t={type:"string",description:${JSON.stringify(desc)}};`
      );
      expect(bodies).toContain(desc);
    });

    describe('exception sites are classified, not dropped', () => {
      const { _setClassificationCacheForTests, sha1Hex } = extractStrings;
      const msg =
        'Cannot enter worktree: the target is the current working directory.';
      const verdict = facing =>
        _setClassificationCacheForTests({ [sha1Hex(msg)]: { facing } });
      afterEach(() => _setClassificationCacheForTests(null));

      it('makes an unclassified thrown prose string a candidate, not a capture', () => {
        _setClassificationCacheForTests({ _: {} });
        for (const site of [
          `function f(){throw new Error(${JSON.stringify(msg)})}`,
          `function f(){throw new ndH(${JSON.stringify(msg)})}`,
          `class E extends Error{constructor(){super(${JSON.stringify(msg)})}}`,
          `function f(){return Promise.reject(new Error(${JSON.stringify(msg)}))}`,
          `var s=z.string().refine(e=>e,{message:${JSON.stringify(msg)}});`,
        ]) {
          const { bodies, candidates } = extract(site);
          expect(bodies).not.toContain(msg);
          expect(candidates).toContain(msg);
        }
      });

      it('makes a thrown template literal a candidate under its decoded body', () => {
        _setClassificationCacheForTests({ _: {} });
        const { candidates } = extract(
          'function f(e){throw new Error(`Cannot enter worktree: ${e} is the current working directory.`)}'
        );
        expect(
          candidates.some(c => c.startsWith('Cannot enter worktree: '))
        ).toBe(true);
      });

      it('does not make thrown identifiers, paths or enum values candidates', () => {
        _setClassificationCacheForTests({ _: {} });
        for (const junk of [
          'ERR_INVALID_ARG_TYPE_FOR_THE_PROVIDED_CALLBACK_FUNCTION',
          '/usr/local/lib/node_modules/some/deep/package/path.js',
          'properties.input_schema.properties.command.type',
        ]) {
          const { candidates } = extract(
            `function f(){throw new Error(${JSON.stringify(junk)})}`
          );
          expect(candidates).not.toContain(junk);
        }
      });

      // CC 2.1.296: `model` verdicts on sibling arms such as `error` and
      // `read_file` catalogued every string node of that word, 11,357 entries.
      it('never captures a bare word on a model verdict', () => {
        _setClassificationCacheForTests({
          [sha1Hex('error')]: { facing: 'model' },
          [sha1Hex('read_file')]: { facing: 'model' },
          [sha1Hex('3 errors found')]: { facing: 'model' },
        });
        const { bodies } = extract(
          'function f(e,n){if(e.kind==="error")return n?"read_file":"error";return {content:"3 errors found"}}'
        );
        expect(bodies).not.toContain('error');
        expect(bodies).not.toContain('read_file');
        expect(bodies).toContain('3 errors found');
        expect(extractStrings.isBareToken(' error ')).toBe(true);
        expect(extractStrings.isBareToken('/model')).toBe(false);
        expect(extractStrings.isBareToken('Status:')).toBe(false);
      });

      // CC 2.1.294: two arms of one ternary share their first 89 chars. The
      // relaunch arm was catalogued, and the sidecar filter dropped the
      // resume-only arm because a captured prompt contained its 80-char opening.
      it('keeps a candidate whose opening a captured sibling shares', () => {
        const open =
          'These background agents fetched web content during the previous session and therefore have ';
        const caught = `${open}nothing to check, so launch them again if their reports are still needed.`;
        const pending = `${open}no worktree or output to check, so resume them with the messaging tool only.`;
        _setClassificationCacheForTests({
          [sha1Hex(caught)]: { facing: 'model' },
        });
        const { bodies, candidates } = extract(
          `function f(w){if(w)throw new Error(${JSON.stringify(pending)});return ${JSON.stringify(caught)}}`
        );
        expect(bodies).toContain(caught);
        expect(candidates).toContain(pending);
      });

      it('drops a candidate whose only site sits inside a captured prompt', () => {
        const inner =
          'Do not assume the tasks landed; launch them again if their results are still needed.';
        const code = `function f(c,e){return \`Background agents were lost when the previous session ended. \${c?(()=>{throw new Error(${JSON.stringify(inner)})})():e}\`}`;
        const f = path.join(
          os.tmpdir(),
          `pe-test-${process.pid}-${Math.random().toString(36).slice(2)}.js`
        );
        fs.writeFileSync(f, code);
        let outer;
        try {
          outer = extractStrings
            .collectLiteralSites(f)
            .find(s => s.kind === 'template').cacheBody;
        } finally {
          fs.unlinkSync(f);
        }
        _setClassificationCacheForTests({ _: {} });
        expect(extract(code).candidates).toContain(inner);
        _setClassificationCacheForTests({
          [sha1Hex(outer)]: { facing: 'model' },
        });
        const { bodies, candidates } = extract(code);
        expect(bodies).toContain(outer);
        expect(candidates).not.toContain(inner);
      });

      it('drops a thrown string whose cached verdict is ui or internal', () => {
        for (const facing of ['ui', 'internal']) {
          verdict(facing);
          const { bodies, candidates } = extract(
            `function f(){throw new Error(${JSON.stringify(msg)})}`
          );
          expect(bodies).not.toContain(msg);
          expect(candidates).not.toContain(msg);
        }
      });

      it('catalogues a thrown string whose cached verdict is model', () => {
        verdict('model');
        const { bodies } = extract(
          `function f(){throw new Error(${JSON.stringify(msg)})}`
        );
        expect(bodies).toContain(msg);
      });

      it('never lets a cached model verdict override a UI-only site', () => {
        // The cache is content-keyed: a verdict earned at a tool-result site
        // must not catalogue the Ink/console copy of the same words.
        verdict('model');
        for (const site of [
          `var e=X.createElement(B,{color:"red"},${JSON.stringify(msg)});`,
          `var e=Y.jsx(T,{dimColor:!0,children:${JSON.stringify(msg)}});`,
          `console.warn(${JSON.stringify(msg)});`,
          `process.stdout.write(${JSON.stringify(msg)});`,
        ]) {
          expect(run(site)).not.toContain(msg);
        }
        expect(
          run(`var r={type:"text",text:${JSON.stringify(msg)}};`)
        ).toContain(msg);
      });

      it('drops UI-only sites before slot-literal and settings verdicts too', () => {
        // Both are matched by text, so they share the cache's content-keyed
        // hazard: the console.error twin of the /plugin validate message.
        const { shouldCapture } = extractStrings;
        _setClassificationCacheForTests({ _: {} });
        for (const opts of [
          { slotLiteral: true },
          { settingsDescription: true },
        ]) {
          for (const lead of [
            'return console.error(',
            'e(n,{dimColor:!0,children:',
            'process.stderr.write(',
          ]) {
            expect(shouldCapture(msg, msg, lead, 500, opts)).toBe(false);
          }
          expect(shouldCapture(msg, msg, 'let s=', 500, opts)).toBe(true);
          expect(shouldCapture(msg, msg, 'throw new Error(', 500, opts)).toBe(
            true
          );
        }
      });

      it('makes an unpunctuated thrown error clause a candidate', () => {
        _setClassificationCacheForTests({ _: {} });
        const clause =
          'comments could not be read reliably right now — try again';
        const { bodies, candidates } = extract(
          `function f(){throw new He(${JSON.stringify(clause)})}`
        );
        expect(bodies).not.toContain(clause);
        expect(candidates).toContain(clause);
      });

      it('makes a short thrown error a candidate — no length floor', () => {
        _setClassificationCacheForTests({ _: {} });
        for (const short of [
          'bash: command is required',
          'Plugin path is not a directory: ${p}',
          'not an artifact URL: ${p}',
        ]) {
          const lit = short.includes('${')
            ? `\`${short}\``
            : JSON.stringify(short);
          const { bodies, candidates } = extract(
            `function f(p){throw new Error(${lit})}`
          );
          expect(bodies).not.toContain(short);
          expect(
            candidates.some(c => c.startsWith(short.replace('${p}', '')))
          ).toBe(true);
        }
        // The floor stays for unsignalled strings at ordinary sites.
        expect(
          extract('var s="bash: command is required";').candidates
        ).toEqual([]);
      });

      it('keeps the exception prose bar off keyword tables and regex sources', () => {
        _setClassificationCacheForTests({ _: {} });
        for (const junk of [
          'array bigint bool byte char datetime decimal double single',
          '^(?:[a-z]+\\s)+\\d+$|^(?:foo|bar|baz)[-_]?qux$',
          'CLAUDE_CODE_SOME_FLAG CLAUDE_CODE_OTHER_FLAG CLAUDE_CODE_THIRD',
        ]) {
          const { candidates } = extract(
            `function f(){throw new Error(${JSON.stringify(junk)})}`
          );
          expect(candidates).not.toContain(junk);
        }
      });

      it('still drops unclassified console and jsx-children strings silently', () => {
        _setClassificationCacheForTests({ _: {} });
        for (const site of [
          `console.error(${JSON.stringify(msg)});`,
          `var e=Y.jsx(T,{dimColor:!0,children:${JSON.stringify(msg)}});`,
          `var e=X.createElement(B,{color:"red"},${JSON.stringify(msg)});`,
          `process.stderr.write(${JSON.stringify(msg)});`,
        ]) {
          const { bodies, candidates } = extract(site);
          expect(bodies).not.toContain(msg);
          expect(candidates).not.toContain(msg);
        }
      });
    });

    it('drops a createElement (Ink UI) child', () => {
      const ui =
        'Voice connection failed. Check your network and try again now.';
      const bodies = run(
        `var e=X.createElement(B,{color:"red"},${JSON.stringify(ui)});`
      );
      expect(bodies).not.toContain(ui);
    });

    // CC 2.1.296 renamed the arrow parameter `O` to `M` inside this slot of
    // the start_task refusal; the catalogue held `String(O)` as piece text, so
    // the body, its cache key and its id all changed with a minifier rename.
    it('keeps no minified name from inside a slot expression in its pieces', () => {
      const build = (table, param) =>
        `var Ymn={type:"string",description:\`\${p??"the arguments"} must be \${R.map((${param})=>${table}[String(${param})]??String(${param})).join(" or ")}\`};`;
      const shape = code => {
        const f = path.join(
          os.tmpdir(),
          `pe-test-${process.pid}-${Math.random().toString(36).slice(2)}.js`
        );
        fs.writeFileSync(f, code);
        try {
          const hit = extractStrings(f).prompts.find(p =>
            p.pieces.join('').includes('must be')
          );
          return { pieces: hit.pieces, identifiers: hit.identifiers };
        } finally {
          fs.unlinkSync(f);
        }
      };
      const darwin = shape(build('br', 'O'));
      const linux = shape(build('Qx', 'M'));
      expect(linux).toEqual(darwin);
      expect(darwin.pieces.join('')).toBe(
        '${??"the arguments"} must be ${.map(()=>[()]??()).join(" or ")}'
      );
    });

    it('still captures an above-floor prose prompt (no baseline regression)', () => {
      const long =
        'You are an interactive CLI tool. You must always be helpful and you should ' +
        'follow instructions carefully. '.repeat(20);
      const bodies = run(`var s=${JSON.stringify(long)};`);
      expect(bodies.some(b => b.includes('interactive CLI tool'))).toBe(true);
    });

    // CC 2.1.328 shapes flagged by detectionCoverage. Each composite is queued
    // for classification under its joined text, and a model verdict on that
    // text captures its prose fragments, which is what the coverage gate reads.
    describe('multi-node composites wait for a verdict on the joined text', () => {
      const { _setClassificationCacheForTests, sha1Hex } = extractStrings;
      afterEach(() => _setClassificationCacheForTests(null));

      const helpLines = [
        '\n\nCommon issues:\n',
        '· Permission denied → run: gh auth refresh -h github.com -s repo,workflow\n',
        '· Not authorized → you need admin access to the repository\n',
        '· Manual setup → https://github.com/anthropics/claude-code-action',
      ];
      const reason =
        'the field in a `query.where` clause is a top-level field name, not empty and with no dot';
      const outcome =
        'this delete did not go through, and that they can try removing the doc from the project in claude.ai.';
      const shapes = [
        {
          name: 'template + string concat thrown later',
          code: `async function f(N,p){if(N.code!==0){let U=\`${helpLines[0]}\`+\`${helpLines[1]}\`+\`${helpLines[2]}\`+${JSON.stringify(helpLines[3])};throw Error(\`Couldn't create workflow file \${p}: \${N.stderr}\${U}\`)}}`,
          joined: helpLines.join(''),
          prose: helpLines.slice(1),
          keys: [helpLines[0]],
        },
        {
          name: 'Map of [code, reason] pairs',
          code: `var ye=new Map([["where_field",${JSON.stringify(reason)}],["cursor","x"]]);`,
          joined: `where_field\n${reason}`,
          prose: [reason],
          keys: ['where_field'],
        },
        {
          name: 'destructured array of words and an outcome sentence',
          code: `function zo(e,o){let[r,i,h,m]=o?["deleted","delete","project_delete",${JSON.stringify(outcome)}]:["a","b","c","d"];return m}`,
          joined: `deleted\ndelete\nproject_delete\n${outcome}`,
          prose: [outcome],
          keys: ['deleted', 'project_delete'],
        },
      ];

      for (const shape of shapes) {
        it(`${shape.name}: queued without a verdict, captured with one`, () => {
          _setClassificationCacheForTests({ _: {} });
          const before = extract(shape.code);
          for (const p of shape.prose) expect(before.bodies).not.toContain(p);
          expect(before.candidates).toContain(shape.joined);

          _setClassificationCacheForTests({
            [sha1Hex(shape.joined)]: { facing: 'model' },
          });
          const after = extract(shape.code);
          for (const p of shape.prose) expect(after.bodies).toContain(p);
          for (const k of shape.keys) expect(after.bodies).not.toContain(k);
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Identical-site backfill: a prompt byte-identical at several sites needs one
// catalogue entry per site, or multiplicity never matches and the apply skips
// the whole group. The identity key decides which sites count, and getting it
// wrong is silent in both directions — too loose mints entries with nowhere to
// splice, too tight leaves the group unresolvable. Every case below is a real
// shape from the 2.1.228 binary.
describe('templateKey', () => {
  const { templateKey } = require('./promptExtractor.js');

  it('treats sites differing only by minifier renaming as one shape', () => {
    // `Task ${d} is not running (status: ${c.status})` and its twin.
    const a = templateKey('`Task ${d} is not running (status: ${c.status})`');
    const b = templateKey('`Task ${i} is not running (status: ${s.status})`');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('keeps the member suffix, which is literal prompt text', () => {
    // The extractor splits pieces around the IDENTIFIER, so `.name` lands in a
    // piece. `${Od.name}` and `${Ls}` are different prompts; blanking the whole
    // interpolation made them twins and minted 14 entries for 6 sites.
    const named = templateKey('`Permission to use ${Od.name} denied.`');
    const bare = templateKey('`Permission to use ${Ls} denied.`');
    expect(named).not.toBe(bare);
  });

  it('declines an interpolation carrying its own literal text', () => {
    // `${x.env.A??"Custom Fable"}` vs `${y.env.B??"Custom Opus"}` are different
    // prompts. Blanking both made them twins and minted 48 entries for a
    // one-site prompt. Neither is generalisable, so neither gets a key.
    expect(templateKey('`${a.env.A??"Custom Fable"} model`')).toBeNull();
    expect(templateKey('`${b.env.B??"Custom Opus"} model`')).toBeNull();
  });

  it('generalises a bare var while keeping a literal-bearing sibling verbatim', () => {
    // A mixed template still keys, but only over the part that is safe to
    // generalise — so the literal-bearing slot still separates the two.
    const a = templateKey('`${x} used ${y.env.A??"Fable"}`');
    const b = templateKey('`${z} used ${y.env.A??"Fable"}`');
    const c = templateKey('`${z} used ${y.env.B??"Opus"}`');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('declines a template with no interpolation to generalise over', () => {
    expect(templateKey('`plain text`')).toBeNull();
  });

  it('declines nested braces rather than reading them wrong', () => {
    expect(templateKey('`a ${x?{y:1}:2} b`')).toBeNull();
  });
});

describe('sameVarPattern', () => {
  const { sameVarPattern } = require('./promptExtractor.js');
  const node = (...exprs) => {
    let code = '';
    const expressions = exprs.map(text => {
      const start = code.length;
      code += text;
      return { start, end: code.length };
    });
    return { node: { expressions }, code };
  };

  it('accepts a site that reuses its variables in the same places', () => {
    const { node: n, code } = node('e', 'e');
    expect(sameVarPattern({ identifiers: [0, 0] }, n, code)).toBe(true);
  });

  it('rejects a site whose variable-reuse pattern differs', () => {
    // Label encoding is positional: [0,0] means "same var twice". Cloning that
    // onto a site using two distinct vars builds a regex that cannot match.
    const { node: n, code } = node('a', 'b');
    expect(sameVarPattern({ identifiers: [0, 0] }, n, code)).toBe(false);
  });

  it('rejects a differing interpolation count', () => {
    const { node: n, code } = node('a');
    expect(sameVarPattern({ identifiers: [0, 1] }, n, code)).toBe(false);
  });
});

// CC 2.1.295/2.1.296: the model-facing `Stop hook feedback:` framing with its
// feedback on the next line is gone, and a loose `includes` pin had been
// cataloguing the transcript row renderer's `Stop hook feedback: ${…}`.
describe('NEW_PROMPT_ASSIGNMENTS: stop hook feedback framing', () => {
  it('names the newline framing and not the row renderer text', () => {
    expect(
      extractStrings.lookupNewPromptAssignment('Stop hook feedback:\n${x}')?.id
    ).toBe('system-prompt-stop-hook-feedback-framing');
    expect(
      extractStrings.lookupNewPromptAssignment('Stop hook feedback: ${x}')
    ).toBe(null);
  });
});
