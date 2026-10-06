import { describe, it, expect, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ext = require('../../tools/promptExtractor.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto');

const sha1 = (s: string) =>
  crypto.createHash('sha1').update(s).digest('hex') as string;

afterEach(() => {
  ext._setClassificationCacheForTests(null);
  ext.setCcVersionForCacheLookups(null);
});

// ---------------------------------------------------------------------------
// leadShowsDropContext — the 2.7.0 additions. Every lead below is a real
// minified shape from the 2.1.206 cli.js (identifiers shortened).
// ---------------------------------------------------------------------------
describe('leadShowsDropContext (2.7.0 rules)', () => {
  it('drops a direct jsx child (children:"…")', () => {
    expect(ext.leadShowsDropContext('Jn.jsx(h,{dimColor:!0,children:')).toBe(
      true
    );
  });

  it('drops the first element of a children array (children:["…")', () => {
    expect(ext.leadShowsDropContext('Eh.jsxs(h,{color:"x",children:[')).toBe(
      true
    );
  });

  it('drops a subsequent children array element (children:[Da," …")', () => {
    expect(ext.leadShowsDropContext('Cds=Eh.jsxs(h,{children:[Da,')).toBe(true);
  });

  it('does NOT drop on jsx residue from an ADJACENT function', () => {
    // The exact shape that ate tool-result-ask-user-question-timeout: the
    // model-facing template lives in `function Eed(e){return\`…\`}` directly
    // after a jsxs() call — the closed `]` must defuse the children rule,
    // and no unanchored `.jsx(`-anywhere rule may exist.
    const lead =
      'return Eh.jsxs(h,{color:"inactive",children:["\\xB7 ",Sny," \\u2192 ",nIC]},Sny)}function Eed(e){return';
    expect(ext.leadShowsDropContext(lead)).toBe(false);
  });

  // super( / Promise.reject( / zod refine used to drop here. An error thrown in
  // a tool's call path is the tool_result the model reads, so they moved to
  // leadShowsExceptionContext: the site no longer decides facing, the
  // classifier does.
  it('no longer drops Error-subclass constructor messages (super("…"))', () => {
    const lead = 'class X extends Error{constructor(){super(';
    expect(ext.leadShowsDropContext(lead)).toBe(false);
    expect(ext.leadShowsExceptionContext(lead)).toBe(true);
  });

  it('no longer drops rejected-promise reasons', () => {
    for (const lead of [
      'return Promise.reject(',
      'return Promise.reject(new Error(',
    ]) {
      expect(ext.leadShowsDropContext(lead)).toBe(false);
      expect(ext.leadShowsExceptionContext(lead)).toBe(true);
    }
  });

  it('no longer drops zod .refine() validation messages', () => {
    const lead = '.refine((e)=>e.length>0,{message:';
    expect(ext.leadShowsDropContext(lead)).toBe(false);
    expect(ext.leadShowsExceptionContext(lead)).toBe(true);
  });

  it('drops highlight.js grammar keys (keyword lists, lexer regexes)', () => {
    expect(ext.leadShowsDropContext('o={$pattern:r,built_in:')).toBe(true);
    expect(ext.leadShowsDropContext('t={$pattern:/\\.?\\w+/,keyword:')).toBe(
      true
    );
    expect(ext.leadShowsDropContext('variants:[{begin:')).toBe(true);
    expect(ext.leadShowsDropContext('n={keywords:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// leadShowsModelFacingContext — the 2.7.0 additions (nudge catalog fields,
// user-turn content, systemPrompt). Each rule is anchored against the junk
// shape that shares its key.
// ---------------------------------------------------------------------------
describe('leadShowsModelFacingContext (2.7.0 rules)', () => {
  const nudgeLead = (tail: string) =>
    // A realistic nudge object prefix inside the wide lead window.
    `cjr=[{id:"permission-fatigue",situation:"User has denied the same tool-call pattern.",feature:"Deny rules can match a tool input parameter.",${tail}`;

  it('admits a nudge situation right after its id', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'e.hasUsedPlanMode},{id:"permission-fatigue",situation:',
        'Claude has run many similar bash commands.'
      )
    ).toBe(true);
  });

  it('admits a nudge feature (sibling key in the wide window, >=25 chars)', () => {
    expect(
      ext.leadShowsModelFacingContext(
        '{id:"mcp-discovery",situation:"User pastes data from external systems into the conversation.",feature:',
        'MCP connects Claude directly to databases and APIs.'
      )
    ).toBe(true);
  });

  it('rejects the filetype-map "gherkin" (below feature floor)', () => {
    expect(
      ext.leadShowsModelFacingContext(
        '{id:"x",situation:"y",gms:"gams",nc:"gcode",feature:',
        'gherkin'
      )
    ).toBe(false);
  });

  it('rejects a label-map key that merely ENDS with feature:', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'LF_={debug_investigate:"Debug/Investigate",implement_feature:',
        'Implement Feature is a long enough label here'
      )
    ).toBe(false);
  });

  it('admits a nudge action (short command string, sibling keys present)', () => {
    expect(
      ext.leadShowsModelFacingContext(nudgeLead('action:'), '/chrome')
    ).toBe(true);
  });

  it('rejects TUI keyboard-chord hints (no nudge sibling in window)', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'children:[mb.jsx(Ue,{chord:"enter",action:',
        'confirm'
      )
    ).toBe(false);
  });

  it('rejects the POSIX signal table (no closing-quote before action:)', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'situation:"x",{name:"SIGHUP",number:1,action:',
        'terminate'
      )
    ).toBe(false);
  });

  it('admits a hardcoded user-turn message (>=25 chars)', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'messages:[{role:"user",content:',
        '2-4 word lowercase label for this job.'
      )
    ).toBe(true);
  });

  it('rejects max_tokens:1 API health-check payloads (below floor)', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'max_tokens:1,messages:[{role:"user",content:',
        '.'
      )
    ).toBe(false);
  });

  it('admits a systemPrompt: field through one wrapper call', () => {
    expect(
      ext.leadShowsModelFacingContext(
        'let d=hYt({messages:[a],systemPrompt:Zu([',
        'You are an assistant for performing a web search tool use'
      )
    ).toBe(true);
    expect(
      ext.leadShowsModelFacingContext(
        '_9({systemPrompt:',
        'You are a helpful AI assistant tasked with summarizing conversations.'
      )
    ).toBe(true);
  });

  it('rejects a systemPrompt member-call argument (join separator)', () => {
    expect(
      ext.leadShowsModelFacingContext('Pe=HD()?{systemPrompt:t.join(', '\n\n')
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// looksLikeEnglishProse — the candidate filter. Programming-keyword lists ARE
// English words, so the filter must key on punctuation usage, not lexicon.
// ---------------------------------------------------------------------------
describe('looksLikeEnglishProse', () => {
  it('accepts a single-sentence tool description', () => {
    expect(
      ext.looksLikeEnglishProse(
        'Reads a file from the local filesystem and returns its content.'
      )
    ).toBe(true);
  });

  it('accepts prose with an em-dash (ascii ratio tolerance)', () => {
    expect(
      ext.looksLikeEnglishProse(
        'Claude can fetch pages directly — just share the URL with it now.'
      )
    ).toBe(true);
  });

  it('rejects programming-keyword lists (English keywords, no punctuation)', () => {
    expect(
      ext.looksLikeEnglishProse(
        'int float string vector matrix if else switch case default while do for in break continue'
      )
    ).toBe(false);
  });

  it('rejects identifier soup', () => {
    expect(
      ext.looksLikeEnglishProse(
        'AddSubString AdjustLineBreaks AmountInWords Analysis ArrayDimCount ArrayHighBound'
      )
    ).toBe(false);
  });

  it('rejects short fragments (<6 words)', () => {
    expect(ext.looksLikeEnglishProse('Paste the URL instead.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldCapture — decision order: UI-only drop context > curated verdicts >
// cache verdict (hard excludes still win) > exception site (candidate only) >
// static gates.
// ---------------------------------------------------------------------------
describe('shouldCapture', () => {
  const PROSE_GATE_REJECT =
    'The OS protocol handler passes exactly one argument; extra arguments indicate injection via the URL.';

  it("a cache 'model' verdict rescues a prose-gate rejection", () => {
    ext._setClassificationCacheForTests({
      [sha1(PROSE_GATE_REJECT)]: { facing: 'model' },
    });
    expect(
      ext.shouldCapture(PROSE_GATE_REJECT, PROSE_GATE_REJECT, 'return`', 500)
    ).toBe(true);
  });

  it("a cache 'ui' verdict drops a string the gates would admit", () => {
    const passing =
      'You must always check the golden path and edge cases. You should verify everything twice before you report success to the user.';
    ext._setClassificationCacheForTests({
      [sha1(passing)]: { facing: 'ui' },
    });
    expect(ext.shouldCapture(passing, passing, 'x=', 500)).toBe(false);
  });

  it("a structural drop context beats a cache 'model' verdict", () => {
    ext._setClassificationCacheForTests({
      [sha1(PROSE_GATE_REJECT)]: { facing: 'model' },
    });
    expect(
      ext.shouldCapture(
        PROSE_GATE_REJECT,
        PROSE_GATE_REJECT,
        'Jn.jsx(h,{children:',
        500
      )
    ).toBe(false);
  });

  it("an exception site defers to the cache: 'model' captures, 'ui' drops", () => {
    for (const lead of [
      'throw new Error(',
      'constructor(e){super(',
      'return Promise.reject(',
      '.refine((e)=>e.length>0,{message:',
    ]) {
      ext._setClassificationCacheForTests({
        [sha1(PROSE_GATE_REJECT)]: { facing: 'model' },
      });
      expect(
        ext.shouldCapture(PROSE_GATE_REJECT, PROSE_GATE_REJECT, lead, 500)
      ).toBe(true);
      ext._setClassificationCacheForTests({
        [sha1(PROSE_GATE_REJECT)]: { facing: 'ui' },
      });
      expect(
        ext.shouldCapture(PROSE_GATE_REJECT, PROSE_GATE_REJECT, lead, 500)
      ).toBe(false);
    }
  });

  it('an unclassified exception-site string is never captured directly', () => {
    // Even one the static gates would admit: the classifier decides it.
    const passing =
      'You must always check the golden path and edge cases. You should verify everything twice before you report success to the user.';
    ext._setClassificationCacheForTests({});
    expect(ext.shouldCapture(passing, passing, 'x=', 500)).toBe(true);
    expect(ext.shouldCapture(passing, passing, 'throw new Error(', 500)).toBe(
      false
    );
  });

  it("a hard exclude beats a cache 'model' verdict", () => {
    const script = '#!/usr/bin/env node\nconsole.log("hi")';
    ext._setClassificationCacheForTests({
      [sha1(script)]: { facing: 'model' },
    });
    expect(ext.shouldCapture(script, script, 'x=', 500)).toBe(false);
  });

  it('without a verdict, the static gates still decide', () => {
    ext._setClassificationCacheForTests({});
    expect(
      ext.shouldCapture(PROSE_GATE_REJECT, PROSE_GATE_REJECT, 'x=', 500)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyByCache version bridging — a verdict keyed on either the raw or the
// <<CCVERSION>>-normalized form must be found from the other form.
// ---------------------------------------------------------------------------
describe('classifyByCache version bridging (via shouldCapture)', () => {
  it('finds a verdict stored under the normalized form from raw content', () => {
    const raw =
      'This banner mentions Claude Code 9.9.9 and how to update it now.';
    const norm = raw.replace('9.9.9', '<<CCVERSION>>');
    ext._setClassificationCacheForTests({ [sha1(norm)]: { facing: 'model' } });
    ext.setCcVersionForCacheLookups('9.9.9');
    expect(ext.shouldCapture(raw, raw, 'x=', 500)).toBe(true);
  });

  it('finds a verdict stored under the raw form from normalized content', () => {
    const raw =
      'This banner mentions Claude Code 9.9.9 and how to update it now.';
    const norm = raw.replace('9.9.9', '<<CCVERSION>>');
    ext._setClassificationCacheForTests({ [sha1(raw)]: { facing: 'model' } });
    ext.setCcVersionForCacheLookups('9.9.9');
    expect(ext.shouldCapture(norm, norm, 'x=', 500)).toBe(true);
  });
});
