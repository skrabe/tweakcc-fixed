import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REMINDER_REGISTRY } from './systemReminderOverrides';
import {
  parseReminderMarkdown,
  substitutePlaceholders,
} from '../systemReminderSync';

const memoryUpdate = REMINDER_REGISTRY.find(r => r.id === 'memory-update')!;

// Memory_update case shaped like CC 2.1.177's cli.js: the wrapper call is
// preceded by a comma-expression (`return K.push(rm6),HT([U6(...`), unlike the
// other reminder cases which emit `return X([Y(...` directly. discoverWrappers
// used to anchor on `return X([` and so missed this, falling back to the stale
// hardcoded o5/j6 and crashing at runtime with "j6 is not a function".
const MOCK_COMMA_EMIT =
  'case"memory_update":{let K=[`${OSO[H.source]} updated your memory directory: ${H.summary}`];' +
  'return K.push(rm6),HT([U6({content:K.join(`\\n`),isMeta:!0})])}';

// Same case with the wrapper emitted directly after `return` (other builds).
const MOCK_DIRECT_EMIT =
  'case"memory_update":{let K=`updated your memory directory`;' +
  'return HT([U6({content:K,isMeta:!0})])}';

describe('memory-update reminder wrapper discovery', () => {
  it('reads the real wrapper/ctor past a comma-expression, not the o5/j6 fallback', () => {
    const result = memoryUpdate.apply(MOCK_COMMA_EMIT, 'memory changed', false);
    expect(result).not.toBeNull();
    expect(result).toContain('HT([U6({content:');
    expect(result).not.toContain('o5([j6(');
  });

  it('still reads a wrapper emitted directly after return', () => {
    const result = memoryUpdate.apply(
      MOCK_DIRECT_EMIT,
      'memory changed',
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain('HT([U6({content:');
  });

  it('binds the pre-2.1.288 map-read source label by shape', () => {
    const result = memoryUpdate.apply(
      MOCK_COMMA_EMIT,
      'By ${H.sourceLabel}: ${H.summary}',
      false
    );
    expect(result).toContain('content:`By ${OSO[H.source]}: ${H.summary}`');
  });
});

const taskListReminder = REMINDER_REGISTRY.find(
  r => r.id === 'task-list-reminder'
)!;

// 2.1.205 task-reminder case: the feature gate is a TWO-clause guard
// `if(!ZI()||YY())return[]` (2.1.204 was a single `if(!ZI())return[]`). The
// wrapper is gf/Lr and the delta param is `e`. The body must carry the
// "Here are the existing tasks" anchor findCaseBody keys on.
const MOCK_TASK_REMINDER_2205 =
  'switch(e.type){case"task_reminder":{if(!ZI()||YY())return[];' +
  'let r=e.content.map((o)=>`#${o.id}. [${o.status}] ${o.subject}`).join(`\n`),' +
  'n=`The task tools have not been used recently.`;' +
  'if(r.length>0)n+=`\n\nHere are the existing tasks:\n\n${r}`;' +
  'return gf([Lr({content:n,isMeta:!0})])}default:}';

describe('task-list-reminder feature-gate guard', () => {
  it("keeps the 2.1.205 two-clause guard verbatim and binds {{tasks}} to the case's own list", () => {
    const result = taskListReminder.apply(
      MOCK_TASK_REMINDER_2205,
      'Tasks:\n\n${q}',
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain('{if(!ZI()||YY())return[];let r=e.content.map(');
    // never the stale hardcoded fallback (GX is `class GX extends Error` in
    // 2.1.205 → calling it without `new` crashes every task-reminder render)
    expect(result).not.toContain('if(!GX())');
    expect(result).toContain('`Tasks:`,``,[`${r}`,``]');
  });

  it('still handles the single-clause guard shape', () => {
    const single = MOCK_TASK_REMINDER_2205.replace(
      'if(!ZI()||YY())',
      'if(!ZI())'
    );
    const result = taskListReminder.apply(single, 'Tasks:\n\n${q}', false);
    expect(result).not.toBeNull();
    expect(result).toContain('if(!ZI())return[]');
  });

  it('keeps a guard of any shape, since the preamble is never re-emitted', () => {
    const drifted = MOCK_TASK_REMINDER_2205.replace(
      'if(!ZI()||YY())return[]',
      'if(someBareCond)return[]'
    );
    expect(taskListReminder.apply(drifted, 'Tasks:\n\n${q}', false)).toContain(
      '{if(someBareCond)return[];'
    );
  });
});

const taskNotif = REMINDER_REGISTRY.find(
  r => r.id === 'task-notification-framing'
)!;

const NOTIF_BODY =
  '[SYSTEM NOTIFICATION - NOT USER INPUT]\n' +
  'This is an automated background-task event, NOT a message from the user.\n' +
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\n';

// 2.1.183 hoisted the inline body into a standalone framing function
// `function MBl(e){return`…${e}`}` (case site: `return MBl(e);`).
const MOCK_NOTIF_FN_2_1_183 =
  'function MBl(e){return`' + NOTIF_BODY + '${e}`}function NBl(){}';

// <=2.1.182 inline shape: `case"task-notification":return`…${H}`;`.
const MOCK_NOTIF_INLINE =
  'switch(t){case"task-notification":return`' + NOTIF_BODY + '${H}`;default:}';

// 2.1.205 hoisted the framing into a lazily-initialized module var (`hJn`) whose
// label is now wrapped as `${"[SYSTEM NOTIFICATION - NOT USER INPUT]"}`, plus a
// prepend helper `qUr(e){if(e.startsWith(hJn))return e;return`${hJn}${e}`}` that
// APPENDS the message. The framing var holds only the prefix (ends `\n\n`, no
// `${message}` inside). A new anti-injection paragraph was added to the body —
// the anchor tolerates it via `[^`]*`.
const MOCK_NOTIF_LAZYVAR_2205 =
  'var hJn;var azi=b(()=>{hJn=`${"[SYSTEM NOTIFICATION - NOT USER INPUT]"}\n' +
  'This is an automated background-task event, NOT a message from the user.\n' +
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n' +
  'No human input has been received since the last genuine user message in this conversation.\n\n`})' +
  'function qUr(e){if(e.startsWith(hJn))return e;return`${hJn}${e}`}';

describe('task-notification-framing wrapper discovery', () => {
  it('rewrites the 2.1.183 standalone framing function in place, preserving ${param} and the `}` suffix', () => {
    const result = taskNotif.apply(MOCK_NOTIF_FN_2_1_183, 'PREFIX ${H}', false);
    expect(result).not.toBeNull();
    expect(result).toContain('function MBl(e){return`PREFIX ${e}`}');
    // sibling function untouched
    expect(result).toContain('function NBl(){}');
  });

  it('still rewrites the <=2.1.182 inline case shape', () => {
    const result = taskNotif.apply(MOCK_NOTIF_INLINE, 'PREFIX ${H}', false);
    expect(result).not.toBeNull();
    expect(result).toContain('case"task-notification":return`PREFIX ${H}`;');
  });

  it('suppresses to a bare `${param}` on the function shape (empty body)', () => {
    const result = taskNotif.apply(MOCK_NOTIF_FN_2_1_183, '${H}', true);
    expect(result).toContain('function MBl(e){return`${e}`}');
  });

  it('fails loud (null) when the framing body text changed', () => {
    const drifted = 'function MBl(e){return`[DIFFERENT FRAMING]\n${e}`}';
    expect(taskNotif.apply(drifted, 'x ${H}', false)).toBeNull();
  });

  it('rewrites the 2.1.205 lazy framing var in place, stripping the appended-message placeholder and leaving qUr untouched', () => {
    const result = taskNotif.apply(
      MOCK_NOTIF_LAZYVAR_2205,
      'MY FRAMING\n\n${H}',
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain('hJn=`MY FRAMING\n\n`');
    // the prepend helper that appends the message must be untouched
    expect(result).toContain(
      'function qUr(e){if(e.startsWith(hJn))return e;return`${hJn}${e}`}'
    );
  });

  it('suppresses the 2.1.205 lazy framing var to an empty template (empty body)', () => {
    const result = taskNotif.apply(MOCK_NOTIF_LAZYVAR_2205, '${H}', true);
    expect(result).not.toBeNull();
    expect(result).toContain('hJn=``');
  });
});

const userNewMsg = REMINDER_REGISTRY.find(
  r => r.id === 'user-sent-new-message'
)!;

// 2.1.205 reworded the trailing framing to an explanatory sentence and keeps the
// hoisted intro var (`${ksa}`). The em-dash is the literal `—` escape in the
// template source (backslash + u2014), so the fixture carries it as `\\u2014`.
const MOCK_USERMSG_2205 =
  'case"auto-continuation":case"human":case void 0:return`${ksa}${e}\n\n' +
  'This is how Claude Code surfaces messages the user sends mid-turn \\u2014 within ' +
  'the running turn, often alongside the next tool result, rather than as a ' +
  'separate conversation turn. Address the message above as you continue this turn.`';

// <=2.1.204 imperative framing (older intro var `${$Tq}`, message var `${H}`).
const MOCK_USERMSG_2204 =
  'case"human":case void 0:return`${$Tq}${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`";

describe('user-sent-new-message wrapper discovery', () => {
  it('rewrites the 2.1.205 reworded mid-turn framing, capturing the message var', () => {
    const result = userNewMsg.apply(MOCK_USERMSG_2205, 'MSG ${H}', false);
    expect(result).not.toBeNull();
    expect(result).toContain(
      'case"auto-continuation":case"human":case void 0:return`MSG ${e}`'
    );
  });

  it('still rewrites the <=2.1.204 imperative framing via the trailing alternation', () => {
    const result = userNewMsg.apply(MOCK_USERMSG_2204, 'MSG ${H}', false);
    expect(result).not.toBeNull();
    expect(result).toContain('case"human":case void 0:return`MSG ${H}`');
  });

  it('suppresses to a bare message var (empty body)', () => {
    const result = userNewMsg.apply(MOCK_USERMSG_2205, '${H}', true);
    expect(result).not.toBeNull();
    expect(result).toContain('return`${e}`');
  });

  it('fails loud (null) when the framing text drifted', () => {
    const drifted =
      'case"human":case void 0:return`${ksa}${e}\n\n[SOME NEW UNRELATED FRAMING]`';
    expect(userNewMsg.apply(drifted, 'x ${H}', false)).toBeNull();
  });
});

const selectedLines = REMINDER_REGISTRY.find(
  r => r.id === 'selected-lines-in-ide'
)!;

// Body the runtime hands `apply`: the defaultBody with placeholders already
// substituted to their `${H.x}` / `${q}` expressions by substitutePlaceholders.
const SELECTED_LINES_BODY =
  'The user selected the lines ${H.lineStart} to ${H.lineEnd} from ' +
  '${H.filename}:\n${q}\n\nThis may or may not be related to the current task.';

// 2.1.186+ direct-arrow shape: the truncation `{let q=…substring(0,2000)…}`
// wrapper is gone and the selected-text slot is an inlined function call
// (`${k6l(e.content)}`) rather than a local var.
const MOCK_SELECTED_NEW_2_1_186 =
  'selected_lines_in_ide:(e)=>sp([Ln({content:`The user selected the lines ' +
  '${e.lineStart} to ${e.lineEnd} from ${e.filename}:\n${k6l(e.content)}\n\n' +
  'This may or may not be related to the current task.`,isMeta:!0})])';

// <=2.1.185 shape: truncated content >2000 chars into a local `q` before emit.
const MOCK_SELECTED_OLD_2_1_185 =
  'selected_lines_in_ide:(H)=>{let q=H.content.length>2000?' +
  'H.content.substring(0,2000)+`\n... (truncated)`:H.content;' +
  'return o5([j6({content:`The user selected the lines ${H.lineStart} to ' +
  '${H.lineEnd} from ${H.filename}:\n${q}\n\nThis may or may not be related ' +
  'to the current task.`,isMeta:!0})])}';

// The sibling diff handler shares the trailing English; the patch must not
// rewrite it (anchored on `selected_lines_in_ide:` + the distinct phrasing).
const MOCK_SELECTED_DIFF_SIBLING =
  'selected_lines_in_diff:(e)=>sp([Ln({content:`The user selected the ' +
  'following ${e.lineCount} ${e.lineCount===1?"line":"lines"} from the diff ' +
  'view:\n${k6l(e.content)}\n\nThis may or may not be related to the current ' +
  'task.`,isMeta:!0})])';

describe('selected-lines-in-ide reminder shape handling', () => {
  it('rewrites the 2.1.186 direct-arrow shape, inlining the captured content expression for ${q}', () => {
    const result = selectedLines.apply(
      MOCK_SELECTED_NEW_2_1_186,
      SELECTED_LINES_BODY,
      false
    );
    expect(result).not.toBeNull();
    // Default body round-trips to the exact pristine code.
    expect(result).toBe(MOCK_SELECTED_NEW_2_1_186);
    // No stale `{let q=…}` wrapper or substring(0,2000) reintroduced.
    expect(result).not.toContain('substring(0,2000)');
    expect(result).toContain('${k6l(e.content)}');
  });

  it('maps a customized body onto the new shape, preserving the inlined content expression', () => {
    const custom =
      'SELECTED ${H.lineStart}-${H.lineEnd} in ${H.filename}:\n${q}';
    const result = selectedLines.apply(
      MOCK_SELECTED_NEW_2_1_186,
      custom,
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain(
      'selected_lines_in_ide:(e)=>sp([Ln({content:`SELECTED ' +
        '${e.lineStart}-${e.lineEnd} in ${e.filename}:\n${k6l(e.content)}`'
    );
  });

  it('suppresses the new shape to a bare empty-array arrow', () => {
    const result = selectedLines.apply(
      MOCK_SELECTED_NEW_2_1_186,
      SELECTED_LINES_BODY,
      true
    );
    expect(result).toContain('selected_lines_in_ide:(e)=>[]');
  });

  it('still rewrites the <=2.1.185 truncating shape via the fallback', () => {
    const result = selectedLines.apply(
      MOCK_SELECTED_OLD_2_1_185,
      SELECTED_LINES_BODY,
      false
    );
    expect(result).not.toBeNull();
    // Round-trips to pristine, keeping the truncation wrapper + local `q`.
    expect(result).toBe(MOCK_SELECTED_OLD_2_1_185);
  });

  it('does not touch the selected_lines_in_diff sibling', () => {
    expect(
      selectedLines.apply(
        MOCK_SELECTED_DIFF_SIBLING,
        'Lines ${H.lineStart}-${H.lineEnd}:\n${q}',
        false
      )
    ).toBeNull();
  });
});

describe('verify-plan reminder removed-feature handling', () => {
  const verifyPlan = REMINDER_REGISTRY.find(
    r => r.id === 'verify-plan-reminder'
  )!;

  // CC 2.1.187 gutted the verify-plan reminder: `verify_plan_reminder` survives
  // only as a type label with no case body / no injected text. The patch must
  // no-op (return content unchanged) instead of failing, so the apply log stays
  // clean on current CC while older supported CC (< 2.1.187) still patches.
  it('no-ops when the verify-plan case body was removed (CC 2.1.187)', () => {
    const removed =
      'function r(){return["plan_mode_enter","plan_mode_exit","verify_plan_reminder"]}';
    expect(verifyPlan.apply(removed, 'body', false)).toBe(removed);
    // Suppression path also no-ops rather than failing.
    expect(verifyPlan.apply(removed, '', true)).toBe(removed);
  });

  // But if the anchor text is still present and the case shape is unmatched,
  // that's a real shape drift on a build that still has the feature — surface it.
  it('still fails (null) on real drift when the anchor text is present', () => {
    const drifted =
      'case"other":You have completed implementing the plan but the shape changed';
    expect(verifyPlan.apply(drifted, 'body', false)).toBeNull();
  });
});

const pdfRef = REMINDER_REGISTRY.find(r => r.id === 'pdf-reference')!;

// CC 2.1.273 rewrote the pdf_reference registry entry: `content:` is no longer
// one template literal but a two-branch ternary (page count known / unknown)
// whose shared tail is a concatenated double-quoted string, and the filename is
// wrapped in an escaper. The single-template anchor missed all of it and the
// patch returned null. Shape copied from the real bundle, names minified the
// same way.
const MOCK_PDF_COMPOSED =
  'pdf_reference:(e)=>gc([Ce({content:(e.pageCount===null?' +
  '`PDF file: ${ou(e.filename)} (page count unknown, ${Mt(e.fileSize)}). ' +
  'It was not attached because it may be too long. Use the ${nt} tool with the pages parameter. `:' +
  '`PDF file: ${ou(e.filename)} (${e.pageCount} pages, ${Mt(e.fileSize)}). ' +
  'This PDF is too large to read all at once. You MUST use the ${nt} tool. `)' +
  '+"Start by reading the first few pages. Maximum 20 pages per request.",isMeta:!0})]),' +
  'selected_lines_in_ide:(e)=>gc([Ce({content:`x`,isMeta:!0})])';

// The pre-2.1.273 single-template shape, which must keep working.
const MOCK_PDF_SIMPLE =
  'pdf_reference:(e)=>gc([Ce({content:`PDF file: ${ou(e.filename)} ' +
  '(${e.pageCount} pages, ${Mt(e.fileSize)}). Use the ${nt} tool.`,isMeta:!0})])';

describe('pdf-reference reminder composed-expression handling', () => {
  it('matches a ternary+concat `content:` and rebinds every slot from it', () => {
    const result = pdfRef.apply(
      MOCK_PDF_COMPOSED,
      'PDF ${H.filename}: ${H.pageCount} pages, ${l7(H.fileSize)}. Use ${uq}.',
      false
    );
    expect(result).not.toBeNull();
    // Slots resolve to the real pristine expressions, escaper included.
    expect(result).toContain('${ou(e.filename)}');
    expect(result).toContain('${e.pageCount}');
    expect(result).toContain('${Mt(e.fileSize)}');
    expect(result).toContain('${nt}');
    // The whole composed expression is replaced by one template, and the
    // neighbouring registry entry is untouched.
    expect(result).not.toContain('page count unknown');
    expect(result).toContain('selected_lines_in_ide:(e)=>gc([Ce({content:`x`');
  });

  it('suppresses the composed shape to an empty emit', () => {
    const result = pdfRef.apply(MOCK_PDF_COMPOSED, '', true);
    expect(result).toContain('pdf_reference:(e)=>[]');
    expect(result).not.toContain('page count unknown');
  });

  it('still handles the pre-2.1.273 single-template shape', () => {
    const result = pdfRef.apply(MOCK_PDF_SIMPLE, 'PDF ${H.filename}.', false);
    expect(result).not.toBeNull();
    expect(result).toContain('${ou(e.filename)}');
  });
});

// CC 2.1.291 gave the handler a block body: an early return for a PDF that can
// be read whole, then the too-large note as the final return. Shape copied from
// the real bundle with synthetic names; the nested template inside the ternary
// exercises the brace walk.
const MOCK_PDF_BLOCK =
  'pdf_reference:(e)=>{if("readableWhole"in e&&e.readableWhole)return gc([Ce({content:' +
  '`PDF file: ${ou(e.filename)} (${e.pageCount===null?"page count unknown":`${e.pageCount} ${P(e.pageCount,"page")}`}, ${Mt(e.fileSize)}). ' +
  'Its content is not included here. Read the whole file with the ${nt} tool.`,isMeta:!0})]);' +
  'return gc([Ce({content:(e.pageCount===null?' +
  '`PDF file: ${ou(e.filename)} (page count unknown, ${Mt(e.fileSize)}). It may be too long. Use the ${nt} tool with the pages parameter. `:' +
  '`PDF file: ${ou(e.filename)} (${e.pageCount} ${P(e.pageCount,"page")}, ${Mt(e.fileSize)}). ' +
  '${e.wholeRefusedByModel?`No PDF${e.pageCount>0?`; pages: "1-${e.pageCount}"`:""}.`:"This PDF is too large to read all at once."} ' +
  'You MUST use the ${nt} tool with the pages parameter. `)+`${e.wholeRefusedByModel&&e.pageCount!==null?"":"Start by reading. "}Maximum 20 pages per request.`,isMeta:!0})])},' +
  'selected_lines_in_ide:(e)=>gc([Ce({content:`x`,isMeta:!0})])';

describe('pdf-reference reminder block-body handling', () => {
  it('rebuilds only the final too-large return and rebinds every slot', () => {
    const result = pdfRef.apply(
      MOCK_PDF_BLOCK,
      'PDF ${H.filename}: ${H.pageCount} pages, ${l7(H.fileSize)}. Use ${uq}.',
      false
    );
    expect(result).not.toBeNull();
    expect(result).toContain(
      'pdf_reference:(e)=>{if("readableWhole"in e&&e.readableWhole)return gc([Ce({content:`PDF file: ${ou(e.filename)}'
    );
    expect(result).toContain('Read the whole file with the ${nt} tool.');
    expect(result).toContain(
      ';return gc([Ce({content:`PDF ${ou(e.filename)}: ${e.pageCount} pages, ${Mt(e.fileSize)}. Use ${nt}.`,isMeta:!0})])},selected_lines_in_ide:'
    );
    expect(result).not.toContain('page count unknown", ');
    expect(result).not.toContain('It may be too long');
  });

  it('suppresses the whole block handler to an empty emit', () => {
    const result = pdfRef.apply(MOCK_PDF_BLOCK, '', true);
    expect(result).toContain(
      'pdf_reference:(e)=>[],selected_lines_in_ide:(e)=>gc('
    );
    expect(result).not.toContain('readableWhole');
  });

  it('is idempotent on its own output', () => {
    const once = pdfRef.apply(MOCK_PDF_BLOCK, 'PDF ${H.filename}.', false)!;
    const twice = pdfRef.apply(once, 'PDF ${H.filename}.', false);
    expect(twice).toBe(once);
  });
});

describe('pdf-reference page_count_text and stock-stub handling', () => {
  const USER_BODY =
    'PDF ${H.filename}: ${H.pageCountText}, ${l7(H.fileSize)}. Read via ${uq} with \\`pages: "1-5"\\` (max 20/request; pages param required).';

  const render = (out: string, pageCount: number | null): string => {
    const m = out.match(/;return gc\(\[Ce\(\{content:(`.*?`),isMeta/s)!;
    const fn = new Function('e', 'ou', 'Mt', 'nt', 'P', `return ${m[1]}`);
    return fn(
      { filename: 'a.pdf', pageCount, fileSize: 9 },
      (x: string) => x,
      (x: number) => `${x}B`,
      'Read',
      (n: number, w: string) => (n === 1 ? w : w + 's')
    ) as string;
  };

  it("recovers CC's own page-count expression and renders null / 1 / 7", () => {
    const out = pdfRef.apply(MOCK_PDF_BLOCK, USER_BODY, false)!;
    expect(out).toContain(
      '${e.pageCount===null?"page count unknown":`${e.pageCount} ${P(e.pageCount,"page")}`}'
    );
    expect(render(out, null)).toBe(
      'PDF a.pdf: page count unknown, 9B. Read via Read with `pages: "1-5"` (max 20/request; pages param required).'
    );
    expect(render(out, 1)).toContain('PDF a.pdf: 1 page, 9B.');
    expect(render(out, 7)).toContain('PDF a.pdf: 7 pages, 9B.');
  });

  it('synthesizes the expression for shapes that never interpolate it', () => {
    const out = pdfRef.apply(MOCK_PDF_SIMPLE, USER_BODY, false)!;
    expect(out).toContain(
      '${e.pageCount===null?"page count unknown":e.pageCount+(e.pageCount===1?" page":" pages")}'
    );
  });

  it('keeps {{page_count}} working', () => {
    const out = pdfRef.apply(MOCK_PDF_BLOCK, 'N=${H.pageCount}', false)!;
    expect(out).toContain('content:`N=${e.pageCount}`');
  });

  const stub = () =>
    substitutePlaceholders(pdfRef.defaultBody, pdfRef.placeholders).result;

  it('leaves the handler byte-for-byte untouched for the stock stub body', () => {
    expect(pdfRef.apply(MOCK_PDF_BLOCK, stub(), false)).toBe(MOCK_PDF_BLOCK);
    expect(pdfRef.apply(MOCK_PDF_COMPOSED, stub(), false)).toBe(
      MOCK_PDF_COMPOSED
    );
  });

  it('still suppresses with the stock stub body', () => {
    expect(pdfRef.apply(MOCK_PDF_BLOCK, stub(), true)).toContain(
      'pdf_reference:(e)=>[],selected_lines_in_ide'
    );
  });
});

describe('local-command-caveat reminder anchoring', () => {
  const caveat = REMINDER_REGISTRY.find(r => r.id === 'local-command-caveat')!;
  const KEYS = 'var $2="command-name",F2="local-command-caveat",xBe=[F2];';
  const fn = (text: string) =>
    `function jae(){return ke({content:\`<\${F2}>${text}</\${F2}>\`,isMeta:!0})}function qY(e){return 1}`;

  it('anchors on the registry key, not the caveat prose (2.1.285 wording)', () => {
    const file =
      KEYS + fn('The command below was run directly in Claude Code.');
    const out = caveat.apply(file, 'Custom ${Gq_} note.', false)!;
    expect(out).toContain(
      'function jae(){return ke({content:`<${F2}>Custom ${F2} note.</${F2}>`,isMeta:!0})}'
    );
    expect(out).not.toContain('run directly');
  });

  it('still matches the pre-2.1.285 wording', () => {
    const file =
      KEYS + fn('Caveat: The messages below were generated by the user.');
    expect(caveat.apply(file, 'x', false)).toContain('<${F2}>x</${F2}>');
  });

  it('suppresses to an empty emit', () => {
    const out = caveat.apply(KEYS + fn('anything'), '', true)!;
    expect(out).toContain('function jae(){return ke({content:"",isMeta:!0})}');
  });

  it('fails cleanly when the tag key is absent', () => {
    expect(caveat.apply(fn('anything'), 'x', false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Branch-faithful bodies. Each fixture below is a CC 2.1.291 handler with the
// minified names swapped for synthetic ones; every test splices a terse body
// and then RUNS the spliced handler, on every branch pristine has.
// ---------------------------------------------------------------------------

const sub = (id: string, body: string): string => {
  const entry = REMINDER_REGISTRY.find(r => r.id === id)!;
  const { result, errors } = substitutePlaceholders(body, entry.placeholders);
  expect(errors).toEqual([]);
  return result;
};

const STUBS: Record<string, unknown> = {
  Wa: (x: unknown) => x,
  Mk: (o: { content: string }) => o.content,
  gd: (x: unknown) => (Array.isArray(x) ? x : []),
  esc: (x: string) => `<${x}>`,
  Qx: (x: string) => `Proc[${x}]`,
  Lbl: { dream: 'Dream' },
  AMB: 'AMBIENT.',
  gate: () => true,
  TC: 'TaskCreate',
  TU: 'TaskUpdate',
  RD: 'Read',
};

// Extracts `case"<key>":{…}` from patched source and returns it as a callable
// `(e) => string | []`, with the synthetic helpers bound.
const runCase = (src: string, key: string) => {
  const head = `case"${key}":{`;
  const start = src.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('/*END*/', start);
  const text = src.slice(start, end);
  const fn = new Function(
    ...Object.keys(STUBS),
    `return (e)=>{switch(e.type){${text}}}`
  )(...Object.values(STUBS)) as (e: Record<string, unknown>) => unknown;
  return (e: Record<string, unknown>): string | [] => {
    const out = fn({ type: key, ...e });
    if (Array.isArray(out) && out.length === 0) return [];
    expect(Array.isArray(out)).toBe(true);
    const text = (out as string[])[0];
    expect(text).not.toMatch(/undefined|null|\[object /);
    return text;
  };
};

const MEMORY_2291 =
  'case"memory_update":{if(e.source==="sync_unsaved")return Wa([Mk({content:e.summary,isMeta:!0})]);' +
  'let g=[`${Qx(e.source)} updated your memory directory: ${e.summary}`],h=gd(e.paths),b=gd(e.inContextPaths);' +
  'if(h.length>0)g.push(`Files changed: ${h.map(esc).join(", ")}`);' +
  'if(b.length>0)g.push(`Your loaded copy of ${b.map(esc).join(", ")} is now stale relative to disk \\u2014 Read it again if you need current contents.`);' +
  'return g.push(AMB),Wa([Mk({content:g.join(`\n`),isMeta:!0})])}/*END*/';

describe('memory-update renders every pristine branch', () => {
  const TERSE =
    '{{source}} updated memory: {{summary}}\nFiles: {{paths}}\nStale in context, re-Read: {{in_context_paths}}\n{{ambient_note}}';
  const run = () =>
    runCase(
      memoryUpdate.apply(MEMORY_2291, sub('memory-update', TERSE), false)!,
      'memory_update'
    );

  it('resolves the source label as a call, never a hardcoded map name', () => {
    const out = memoryUpdate.apply(
      MEMORY_2291,
      sub('memory-update', TERSE),
      false
    )!;
    expect(out).toContain('${Qx(e.source)} updated memory');
    expect(out).not.toContain('YT3');
  });

  it('drops the files / stale lines exactly when pristine skips their push', () => {
    const r = run();
    expect(
      r({ source: 'dream', summary: 'S', paths: [], inContextPaths: [] })
    ).toBe('Proc[dream] updated memory: S\nAMBIENT.');
    expect(
      r({
        source: 'dream',
        summary: 'S',
        paths: ['a', 'b'],
        inContextPaths: [],
      })
    ).toBe('Proc[dream] updated memory: S\nFiles: <a>, <b>\nAMBIENT.');
    expect(
      r({ source: 'dream', summary: 'S', paths: ['a'], inContextPaths: ['a'] })
    ).toBe(
      'Proc[dream] updated memory: S\nFiles: <a>\nStale in context, re-Read: <a>\nAMBIENT.'
    );
    // ei()-style guard: a missing list neither throws nor prints
    expect(r({ source: 'dream', summary: 'S', inContextPaths: ['c'] })).toBe(
      'Proc[dream] updated memory: S\nStale in context, re-Read: <c>\nAMBIENT.'
    );
  });

  it('leaves the sync_unsaved early return pristine', () => {
    expect(
      run()({ source: 'sync_unsaved', summary: 'unsaved', paths: ['x'] })
    ).toBe('unsaved');
  });

  it('segment placeholders carry pristine text under pristine conditions', () => {
    const out = memoryUpdate.apply(
      MEMORY_2291,
      sub(
        'memory-update',
        '{{source}}: {{summary}}\n{{files_changed}}\n{{stale_copy}}'
      ),
      false
    )!;
    const r = runCase(out, 'memory_update');
    expect(
      r({ source: 'dream', summary: 'S', paths: [], inContextPaths: [] })
    ).toBe('Proc[dream]: S');
    expect(
      r({ source: 'dream', summary: 'S', paths: ['a'], inContextPaths: ['a'] })
    ).toBe(
      'Proc[dream]: S\nFiles changed: <a>\nYour loaded copy of <a> is now stale relative to disk — Read it again if you need current contents.'
    );
  });

  it('the stock body equals pristine on every branch, and is left untouched', () => {
    const stock = sub('memory-update', memoryUpdate.defaultBody);
    expect(memoryUpdate.apply(MEMORY_2291, stock, false)).toBe(MEMORY_2291);
  });

  it('binds the pre-2.1.288 map-read label', () => {
    const fixture = MEMORY_2291.replace('${Qx(e.source)}', '${Lbl[e.source]}');
    const r = runCase(
      memoryUpdate.apply(fixture, sub('memory-update', TERSE), false)!,
      'memory_update'
    );
    expect(r({ source: 'dream', summary: 'S', paths: [] })).toBe(
      'Dream updated memory: S\nAMBIENT.'
    );
  });

  it('fails loud when the source label has an unrecognised shape', () => {
    const fixture = MEMORY_2291.replace('${Qx(e.source)}', '${Qx(e.source,1)}');
    expect(
      memoryUpdate.apply(fixture, sub('memory-update', TERSE), false)
    ).toBeNull();
  });

  it('suppresses to an empty case', () => {
    const out = memoryUpdate.apply(MEMORY_2291, '', true)!;
    expect(
      runCase(out, 'memory_update')({ source: 'dream', summary: 'S' })
    ).toEqual([]);
  });
});

const mcpInstructions = REMINDER_REGISTRY.find(
  r => r.id === 'mcp-instructions'
)!;

const MCP_2291 =
  'case"mcp_instructions_delta":{let s=gd(e.addedBlocks),g=gd(e.addedNames),h=gd(e.removedNames),b=[];' +
  'if(s.length>0&&g.length>0)b.push(`# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${s.join(`\n\n`)}`);' +
  'if(h.length>0)b.push(`The following MCP servers have disconnected. Their instructions above no longer apply:\n${h.join(`\n`)}`),b.push(AMB);' +
  'if(b.length===0)return[];return Wa([Mk({content:b.join(`\n\n`),isMeta:!0})])}/*END*/';

describe('mcp-instructions renders every pristine branch', () => {
  const ADDED = {
    addedBlocks: ['## a\nA'],
    addedNames: ['a'],
    removedNames: [],
  };
  const REMOVED = { addedBlocks: [], addedNames: [], removedNames: ['x', 'y'] };
  const BOTH = {
    addedBlocks: ['## a\nA'],
    addedNames: ['a'],
    removedNames: ['x'],
  };

  it('a terse body with its own wording keeps each half to its own branch', () => {
    const body =
      '# MCP instructions\n{{added_blocks}}\n\nDisconnected (ignore their instructions): {{removed_names}}\n{{ambient_note}}';
    const r = runCase(
      mcpInstructions.apply(MCP_2291, sub('mcp-instructions', body), false)!,
      'mcp_instructions_delta'
    );
    expect(r(ADDED)).toBe('# MCP instructions\n## a\nA');
    expect(r(REMOVED)).toBe(
      '# MCP instructions\n\nDisconnected (ignore their instructions): x\ny\nAMBIENT.'
    );
  });

  it('section placeholders reproduce pristine, including a removal-only delta', () => {
    const body = '{{added_section}}\n\n{{removed_section}}\n\n{{ambient_note}}';
    const out = mcpInstructions.apply(
      MCP_2291,
      sub('mcp-instructions', body),
      false
    )!;
    const r = runCase(out, 'mcp_instructions_delta');
    const pristine = runCase(MCP_2291, 'mcp_instructions_delta');
    for (const delta of [ADDED, REMOVED, BOTH])
      expect(r(delta)).toBe(pristine(delta));
    expect(r(REMOVED)).toBe(
      'The following MCP servers have disconnected. Their instructions above no longer apply:\nx\ny\n\nAMBIENT.'
    );
    expect(r({})).toEqual([]);
  });

  it('an edited legacy {{added_blocks}} body still applies, guarded', () => {
    const legacy = '# MCP Server Instructions (edited)\n\n{{added_blocks}}';
    const r = runCase(
      mcpInstructions.apply(MCP_2291, sub('mcp-instructions', legacy), false)!,
      'mcp_instructions_delta'
    );
    expect(r(ADDED)).toContain('## a\nA');
    expect(r(BOTH)).not.toContain('disconnected');
    expect(r({ removedNames: ['x'] })).not.toContain('\n\n\n');
  });

  it('stock body is a no-op; suppression empties the case', () => {
    expect(
      mcpInstructions.apply(
        MCP_2291,
        sub('mcp-instructions', mcpInstructions.defaultBody),
        false
      )
    ).toBe(MCP_2291);
    expect(
      runCase(
        mcpInstructions.apply(MCP_2291, '', true)!,
        'mcp_instructions_delta'
      )(ADDED)
    ).toEqual([]);
  });
});

const agentListing = REMINDER_REGISTRY.find(r => r.id === 'agent-listing')!;

const AGENT_2291 =
  'case"agent_listing_delta":{let s=gd(e.addedLines),g=gd(e.addedTypes),h=gd(e.removedTypes),b=[];' +
  'if(s.length>0&&g.length>0){let w=e.isInitial?"Available agent types for the Agent tool:":"New agent types are now available for the Agent tool:";b.push(`${w}\n${s.join(`\n`)}`)}' +
  'if(h.length>0)b.push(`The following agent types are no longer available:\n${h.map((w)=>`- ${w}`).join(`\n`)}`),b.push(AMB);' +
  'if(s.length>0&&g.length>0&&e.isInitial&&e.showConcurrencyNote)b.push("When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.");' +
  'if(b.length===0)return[];return Wa([Mk({content:b.join(`\n\n`),isMeta:!0})])}/*END*/';

describe('agent-listing renders every pristine branch', () => {
  const INITIAL = {
    addedLines: ['- a: A'],
    addedTypes: ['a'],
    removedTypes: [],
    isInitial: true,
    showConcurrencyNote: true,
  };
  const LATER = {
    addedLines: ['- b: B'],
    addedTypes: ['b'],
    removedTypes: [],
    isInitial: false,
    showConcurrencyNote: true,
  };
  const REMOVED = {
    addedLines: [],
    addedTypes: [],
    removedTypes: ['z'],
    isInitial: false,
  };
  const BOTH = {
    addedLines: ['- b: B'],
    addedTypes: ['b'],
    removedTypes: ['z'],
    isInitial: false,
  };

  it('{{heading}} follows isInitial and vanishes on a removal-only delta', () => {
    const body =
      '{{heading}}\n{{listing}}\n\nGone: {{removed}}\n\n{{concurrency_note}}';
    const r = runCase(
      agentListing.apply(AGENT_2291, sub('agent-listing', body), false)!,
      'agent_listing_delta'
    );
    expect(r(INITIAL)).toBe(
      'Available agent types for the Agent tool:\n- a: A\n\nWhen you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.'
    );
    expect(r(LATER)).toBe(
      'New agent types are now available for the Agent tool:\n- b: B'
    );
    expect(r(REMOVED)).toBe('Gone: - z');
    expect(r(BOTH)).toBe(
      'New agent types are now available for the Agent tool:\n- b: B\n\nGone: - z'
    );
    expect(r({})).toEqual([]);
  });

  it('section placeholders reproduce pristine on every branch', () => {
    const body =
      '{{added_section}}\n\n{{removed_section}}\n\n{{ambient_note}}\n\n{{concurrency_note}}';
    const r = runCase(
      agentListing.apply(AGENT_2291, sub('agent-listing', body), false)!,
      'agent_listing_delta'
    );
    const pristine = runCase(AGENT_2291, 'agent_listing_delta');
    for (const delta of [INITIAL, LATER, REMOVED, BOTH])
      expect(r(delta)).toBe(pristine(delta));
  });

  it('an edited legacy {{listing}} body still applies, guarded', () => {
    const r = runCase(
      agentListing.apply(
        AGENT_2291,
        sub(
          'agent-listing',
          'Available agent types for the Agent tool:\n{{listing}}'
        ),
        false
      )!,
      'agent_listing_delta'
    );
    expect(r(LATER)).toContain('- b: B');
  });
});

const editedTextFile = REMINDER_REGISTRY.find(
  r => r.id === 'edited-text-file'
)!;

const EDITED_2291 =
  "edited_text_file:(e)=>{let n=`Note: ${esc(e.filename)} changed on disk since you last read it. That's usually deliberate.`;" +
  'return Wa([Mk({content:e.snippet===""?`${n} The changes are not shown here; use ${RD} if you need the current content.`:`${n} Here are the relevant changes (shown with line numbers):\n${e.snippet}`,isMeta:!0})])},at_mention_reference:(e)=>1';

const runEdited = (src: string) => {
  const start = src.indexOf('edited_text_file:');
  const end = src.indexOf(',at_mention_reference:');
  const fn = new Function(
    ...Object.keys(STUBS),
    `return ({${src.slice(start, end)}}).edited_text_file`
  )(...Object.values(STUBS)) as (e: Record<string, unknown>) => string[];
  return (e: Record<string, unknown>) => {
    const text = fn(e)[0];
    expect(text).not.toMatch(/undefined|null/);
    return text;
  };
};

describe('edited-text-file renders both snippet branches', () => {
  it('{{changes}} carries pristine\'s snippet==="" ternary', () => {
    const out = editedTextFile.apply(
      EDITED_2291,
      sub(
        'edited-text-file',
        "{{filename}} changed on disk; don't revert it. {{changes}}"
      ),
      false
    )!;
    const r = runEdited(out);
    expect(r({ filename: 'f.ts', snippet: '' })).toBe(
      "<f.ts> changed on disk; don't revert it. The changes are not shown here; use Read if you need the current content."
    );
    expect(r({ filename: 'f.ts', snippet: '12 x' })).toBe(
      "<f.ts> changed on disk; don't revert it. Here are the relevant changes (shown with line numbers):\n12 x"
    );
  });

  it('a bare {{snippet}} line drops on the no-snippet branch; {{read_tool}} binds', () => {
    const r = runEdited(
      editedTextFile.apply(
        EDITED_2291,
        sub(
          'edited-text-file',
          '{{filename}} changed (use {{read_tool}} for more):\n{{snippet}}'
        ),
        false
      )!
    );
    expect(r({ filename: 'f', snippet: '' })).toBe(
      '<f> changed (use Read for more):'
    );
    expect(r({ filename: 'f', snippet: 'd' })).toBe(
      '<f> changed (use Read for more):\nd'
    );
  });

  it('the stock body is a no-op and matches pristine', () => {
    expect(
      editedTextFile.apply(
        EDITED_2291,
        sub('edited-text-file', editedTextFile.defaultBody),
        false
      )
    ).toBe(EDITED_2291);
  });

  it('the <=2.1.233 inline shape also binds {{changes}}', () => {
    const tail =
      "Note: ${H.filename} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware.";
    const old =
      'edited_text_file:(H)=>Wa([Mk({content:H.snippet===""?`' +
      tail +
      ' The diff was omitted because other modified files in this turn already exceeded the snippet budget; use the Read tool if you need the current content.`:`' +
      tail +
      ' Here are the relevant changes (shown with line numbers):\n${H.snippet}`,isMeta:!0})]),at_mention_reference:(e)=>1';
    const r = runEdited(
      editedTextFile.apply(
        old,
        sub('edited-text-file', '{{filename}}: {{changes}}'),
        false
      )!
    );
    expect(r({ filename: 'f', snippet: '' })).toContain(
      'f: The diff was omitted'
    );
    expect(r({ filename: 'f', snippet: 'd' })).toContain(
      'f: Here are the relevant changes'
    );
  });
});

const TASK_2291 =
  'case"task_reminder":{if(!gate())return[];let s=e.content.map((h)=>`#${h.id}. [${h.status}] ${h.subject}`).join(`\n`),' +
  "g=`The task tools haven't been used recently. Consider using ${TC} to add new tasks and ${TU} to update task status.\n`;" +
  'if(s.length>0)g+=`\n\nHere are the existing tasks:\n\n${s}`;return Wa([Mk({content:g,isMeta:!0})])}/*END*/';

describe('task-list-reminder renders with and without tasks', () => {
  const TASKS = { content: [{ id: 1, status: 'pending', subject: 'A' }] };

  it('the existing-tasks block appears only when the list is non-empty', () => {
    const body =
      'Task tools idle; track multi-step work with {{task_create_tool}} / {{task_update_tool}}.\n\n{{existing_tasks}}';
    const r = runCase(
      taskListReminder.apply(
        TASK_2291,
        sub('task-list-reminder', body),
        false
      )!,
      'task_reminder'
    );
    expect(r({ content: [] })).toBe(
      'Task tools idle; track multi-step work with TaskCreate / TaskUpdate.'
    );
    expect(r(TASKS)).toBe(
      'Task tools idle; track multi-step work with TaskCreate / TaskUpdate.\n\nHere are the existing tasks:\n\n#1. [pending] A'
    );
  });

  it('a "Tasks: {{tasks}}" line drops on the empty list', () => {
    const r = runCase(
      taskListReminder.apply(
        TASK_2291,
        sub(
          'task-list-reminder',
          'Use {{task_create_tool}}.\nTasks: {{tasks}}'
        ),
        false
      )!,
      'task_reminder'
    );
    expect(r({ content: [] })).toBe('Use TaskCreate.');
    expect(r(TASKS)).toBe('Use TaskCreate.\nTasks: #1. [pending] A');
  });

  it('keeps the feature gate, and the stock body is a no-op', () => {
    const out = taskListReminder.apply(
      TASK_2291,
      sub('task-list-reminder', 'x {{tasks}}'),
      false
    )!;
    expect(out).toContain('{if(!gate())return[];');
    expect(
      taskListReminder.apply(
        TASK_2291,
        sub('task-list-reminder', taskListReminder.defaultBody),
        false
      )
    ).toBe(TASK_2291);
  });
});

describe('pdf-reference model_refused_note', () => {
  // Runs the whole spliced handler: an empty render returns [] rather than a
  // message, so the text is read off the wrapper's one element.
  const runPdf = (out: string) => {
    const start = out.indexOf('pdf_reference:');
    const end = out.indexOf(',selected_lines_in_ide:');
    const fn = new Function(
      'ou',
      'Mt',
      'nt',
      'P',
      'gc',
      'Ce',
      `return ({${out.slice(start, end)}}).pdf_reference`
    )(
      (x: string) => x,
      (x: number) => `${x}B`,
      'Read',
      (n: number, w: string) => (n === 1 ? w : w + 's'),
      (x: unknown) => x,
      (o: { content: string }) => o.content
    ) as (e: Record<string, unknown>) => string[];
    return (e: Record<string, unknown>) =>
      fn({ filename: 'a.pdf', fileSize: 9, ...e })[0];
  };

  it("carries pristine's refused sentence and drops when not refused", () => {
    const out = pdfRef.apply(
      MOCK_PDF_BLOCK,
      sub(
        'pdf-reference',
        'PDF {{filename}}: {{page_count_text}}. Use {{read_tool}} with pages.\n{{model_refused_note}}'
      ),
      false
    )!;
    const r = runPdf(out);
    expect(r({ pageCount: 7 })).toBe(
      'PDF a.pdf: 7 pages. Use Read with pages.'
    );
    expect(r({ pageCount: 7, wholeRefusedByModel: true })).toBe(
      'PDF a.pdf: 7 pages. Use Read with pages.\nNo PDF; pages: "1-7".'
    );
    expect(r({ pageCount: null, wholeRefusedByModel: true })).toBe(
      'PDF a.pdf: page count unknown. Use Read with pages.\nNo PDF.'
    );
  });

  it('is empty on shapes that predate the refusal', () => {
    const out = pdfRef.apply(
      MOCK_PDF_SIMPLE,
      sub('pdf-reference', 'x\n{{model_refused_note}}'),
      false
    )!;
    expect(out).toContain('[`${""}`,``]');
  });
});

describe('stock-body no-op covers the whole registry', () => {
  const DUMMY = 'no reminder handlers in here';

  it.each(REMINDER_REGISTRY.filter(e => !e.bodyIsMarker).map(e => e.id))(
    '%s leaves content untouched for its own default body',
    id => {
      const entry = REMINDER_REGISTRY.find(r => r.id === id)!;
      const stock = substitutePlaceholders(
        entry.defaultBody,
        entry.placeholders
      ).result;
      expect(entry.apply(DUMMY, stock, false)).toBe(DUMMY);
      expect(entry.apply(DUMMY, `${stock}\n`, false)).toBe(DUMMY);
      expect(entry.apply(DUMMY, stock.replace(/\n/g, '\r\n'), false)).toBe(
        DUMMY
      );
    }
  );

  it('never short-circuits a suppression or the router marker', () => {
    const router = REMINDER_REGISTRY.find(
      r => r.id === 'mcp-per-server-router'
    )!;
    expect(router.apply(DUMMY, router.defaultBody, false)).toBeNull();
    const mem = REMINDER_REGISTRY.find(r => r.id === 'memory-update')!;
    expect(mem.apply(DUMMY, '', true)).toBeNull();
  });

  it('carries no hardcoded minified fallback names', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'systemReminderOverrides.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/\?\? '[$\w]+'/);
    expect(src).not.toMatch(/: 'H';|'o5'|'j6'/);
  });
});

describe('mcp-per-server-router suppression covers client-side blocks', () => {
  const router = REMINDER_REGISTRY.find(r => r.id === 'mcp-per-server-router')!;
  const ZJE =
    'function Zje(e,n){let r=new Map;for(let g of e)if(g.instructions)r.set(g.name,`## ${g.name}\n${g.instructions}`);' +
    'let s=new Set(e.map((g)=>g.name));for(let g of n){if(!s.has(g.serverName))continue;let h=r.get(g.serverName);' +
    'r.set(g.serverName,h?`${h}\n\n${g.block}`:`## ${g.serverName}\n${g.block}`)}return r}';

  const run = (files: Record<string, string>) => {
    const out = router.apply(ZJE, router.defaultBody, false)!;
    const fakeRequire = (m: string) =>
      m === 'os'
        ? { homedir: () => '/h' }
        : {
            readFileSync: (p: string) => {
              const name = p.split('/').pop()!;
              if (!(name in files)) throw new Error('ENOENT');
              return files[name];
            },
          };
    const zje = new Function('require', `${out};return Zje`)(fakeRequire) as (
      e: unknown[],
      n: unknown[]
    ) => Map<string, string>;
    return zje(
      [
        { name: 'claude-in-chrome', instructions: 'CI' },
        { name: 'other', instructions: 'OI' },
      ],
      [
        { serverName: 'claude-in-chrome', block: 'EXTRA' },
        { serverName: 'other', block: 'OB' },
      ]
    );
  };

  it('an emptied mcp-<name>.md drops the server and its extra block', () => {
    const m = run({ 'mcp-claude-in-chrome.md': '<!--\nname: x\n-->\n' });
    expect(m.has('claude-in-chrome')).toBe(false);
    expect(m.get('other')).toBe('## other\nOI\n\nOB');
  });

  it('a custom body keeps the extra block appended', () => {
    const m = run({ 'mcp-claude-in-chrome.md': '<!--\nname: x\n-->\nTERSE' });
    expect(m.get('claude-in-chrome')).toBe(
      '## claude-in-chrome\nTERSE\n\nEXTRA'
    );
  });
});

describe('a body that renders to nothing emits nothing', () => {
  it('task-list-reminder: {{existing_tasks}} alone returns [] on an empty list', () => {
    const r = runCase(
      taskListReminder.apply(
        TASK_2291,
        sub('task-list-reminder', '{{existing_tasks}}'),
        false
      )!,
      'task_reminder'
    );
    expect(r({ content: [] })).toEqual([]);
    expect(r({ content: [{ id: 1, status: 'pending', subject: 'A' }] })).toBe(
      'Here are the existing tasks:\n\n#1. [pending] A'
    );
  });

  it('mcp-instructions: {{added_section}} alone returns [] on a removal-only delta', () => {
    const r = runCase(
      mcpInstructions.apply(
        MCP_2291,
        sub('mcp-instructions', '{{added_section}}'),
        false
      )!,
      'mcp_instructions_delta'
    );
    expect(r({ addedBlocks: [], addedNames: [], removedNames: ['x'] })).toEqual(
      []
    );
    expect(
      r({ addedBlocks: ['## a\nA'], addedNames: ['a'], removedNames: [] })
    ).toContain('## a\nA');
  });

  it('agent-listing and memory-update bodies of optional lines only return []', () => {
    const agent = runCase(
      agentListing.apply(
        AGENT_2291,
        sub('agent-listing', '{{added_section}}\n\n{{concurrency_note}}'),
        false
      )!,
      'agent_listing_delta'
    );
    expect(agent({ removedTypes: ['z'] })).toEqual([]);
    const mem = runCase(
      memoryUpdate.apply(
        MEMORY_2291,
        sub('memory-update', 'Files: {{paths}}\n{{stale_copy}}'),
        false
      )!,
      'memory_update'
    );
    expect(
      mem({ source: 'dream', summary: 'S', paths: [], inContextPaths: [] })
    ).toEqual([]);
    expect(mem({ source: 'dream', summary: 'S', paths: ['a'] })).toBe(
      'Files: <a>'
    );
  });

  it('edited-text-file and pdf-reference return [] for an empty optional render', () => {
    const edited = editedTextFile.apply(
      EDITED_2291,
      sub('edited-text-file', '{{snippet}}'),
      false
    )!;
    const start = edited.indexOf('edited_text_file:');
    const fn = new Function(
      ...Object.keys(STUBS),
      `return ({${edited.slice(start, edited.indexOf(',at_mention_reference:'))}}).edited_text_file`
    )(...Object.values(STUBS)) as (e: Record<string, unknown>) => unknown;
    expect(fn({ filename: 'f', snippet: '' })).toEqual([]);
    expect(fn({ filename: 'f', snippet: 'd' })).toEqual(['d']);
    const pdf = pdfRef.apply(
      MOCK_PDF_BLOCK,
      sub('pdf-reference', '{{model_refused_note}}'),
      false
    )!;
    expect(pdf).toContain(
      '((c)=>c.trim()===""?[]:gc([Ce({content:c,isMeta:!0})]))('
    );
  });

  it('static bodies keep the plain wrapper call, and suppression is unchanged', () => {
    const out = taskListReminder.apply(TASK_2291, 'Static text only.', false)!;
    expect(out).toContain(
      'return Wa([Mk({content:`Static text only.`,isMeta:!0})])'
    );
    expect(
      runCase(
        taskListReminder.apply(TASK_2291, '', true)!,
        'task_reminder'
      )({ content: [] })
    ).toEqual([]);
  });
});

describe('review fixes', () => {
  it('[P1] an .md still holding an earlier stock body is a no-op', () => {
    const oldMcp = mcpInstructions.previousDefaultBodies!.find(b =>
      b.includes('{{added_blocks}}')
    )!;
    expect(
      mcpInstructions.apply(MCP_2291, sub('mcp-instructions', oldMcp), false)
    ).toBe(MCP_2291);
    const oldAgent = 'Available agent types for the Agent tool:\n{{listing}}';
    expect(agentListing.previousDefaultBodies).toContain(oldAgent);
    expect(
      agentListing.apply(AGENT_2291, sub('agent-listing', oldAgent), false)
    ).toBe(AGENT_2291);
    for (const old of memoryUpdate.previousDefaultBodies!)
      expect(
        memoryUpdate.apply(MEMORY_2291, sub('memory-update', old), false)
      ).toBe(MEMORY_2291);
    // An edit of the old stub is a customization and still applies.
    expect(
      mcpInstructions.apply(
        MCP_2291,
        sub('mcp-instructions', oldMcp + ' x'),
        false
      )
    ).not.toBe(MCP_2291);
  });

  it('[P2] an edited pdf stub stays correct on null-count and refused branches', () => {
    const edited = pdfRef.defaultBody.replace('Maximum 20', 'At most 20');
    const out = pdfRef.apply(
      MOCK_PDF_BLOCK,
      sub('pdf-reference', edited),
      false
    )!;
    const start = out.indexOf('pdf_reference:');
    const fn = new Function(
      'ou',
      'Mt',
      'nt',
      'P',
      'gc',
      'Ce',
      `return ({${out.slice(start, out.indexOf(',selected_lines_in_ide:'))}}).pdf_reference`
    )(
      (x: string) => x,
      (x: number) => `${x}B`,
      'Read',
      (n: number, w: string) => (n === 1 ? w : w + 's'),
      (x: unknown) => x,
      (o: { content: string }) => o.content
    ) as (e: Record<string, unknown>) => string[];
    const nullCount = fn({ filename: 'a', fileSize: 9, pageCount: null })[0];
    expect(nullCount).toContain('(page count unknown, 9B)');
    expect(nullCount).not.toContain('null');
    const refused = fn({
      filename: 'a',
      fileSize: 9,
      pageCount: 7,
      wholeRefusedByModel: true,
    })[0];
    expect(refused).toContain('No PDF; pages: "1-7".');
    expect(refused).not.toContain('too large');
    expect(fn({ filename: 'a', fileSize: 9, pageCount: 7 })[0]).toContain(
      'This PDF is too large to read all at once.'
    );
    // The old "{{page_count}} pages" stub is still recognised as unedited.
    expect(
      pdfRef.apply(
        MOCK_PDF_BLOCK,
        sub('pdf-reference', pdfRef.previousDefaultBodies![0]),
        false
      )
    ).toBe(MOCK_PDF_BLOCK);
  });

  it('[P2] builder cases re-splice their own output identically', () => {
    const cases: Array<[typeof memoryUpdate, string, string]> = [
      [memoryUpdate, MEMORY_2291, 'Files: {{paths}}\n{{ambient_note}}'],
      [
        taskListReminder,
        TASK_2291,
        'Use {{task_create_tool}}.\n\n{{existing_tasks}}',
      ],
      [mcpInstructions, MCP_2291, '{{added_section}}\n\n{{removed_section}}'],
      [agentListing, AGENT_2291, '{{heading}}\n{{listing}}'],
      [memoryUpdate, MEMORY_2291, 'Static only.'],
    ];
    for (const [entry, fixture, body] of cases) {
      const b = sub(entry.id, body);
      const once = entry.apply(fixture, b, false)!;
      expect(once).not.toBeNull();
      expect(entry.apply(once, b, false)).toBe(once);
      const suppressed = entry.apply(fixture, '', true)!;
      expect(entry.apply(suppressed, '', true)).toBe(suppressed);
    }
    // the ambient suffix push survives the splice, so a re-splice binds it
    const once = memoryUpdate.apply(
      MEMORY_2291,
      sub('memory-update', '{{summary}}\n{{ambient_note}}'),
      false
    )!;
    expect(once).toContain('return g.push(AMB),');
  });

  it('[P2] the router finds the client-side loop however far it sits', () => {
    const router = REMINDER_REGISTRY.find(
      r => r.id === 'mcp-per-server-router'
    )!;
    const filler = 'let pad=`' + 'x'.repeat(2000) + '`;';
    const zje =
      'function Zje(e,n){let r=new Map;for(let g of e)if(g.instructions)r.set(g.name,`## ${g.name}\n${g.instructions}`);' +
      filler +
      'let s=new Set(e.map((g)=>g.name));for(let g of n){if(!s.has(g.serverName))continue;r.set(g.serverName,g.block)}return r}' +
      'function other(n){for(let g of n){if(!q.has(g.serverName))continue}}';
    const out = router.apply(zje, router.defaultBody, false)!;
    expect(out).toContain(
      'for(let g of n){if(__tweakccMcpOverride(g.serverName,"")===null)continue;if(!s.has('
    );
    // never reaches past the enclosing function
    expect(out).toContain('function other(n){for(let g of n){if(!q.has(');
  });

  it('[P3] stock comparison keeps meaningful whitespace and folds CRLF', () => {
    const mention = REMINDER_REGISTRY.find(r => r.id === 'agent-mention')!;
    const stock = sub('agent-mention', mention.defaultBody);
    expect(stock.endsWith(' ')).toBe(true);
    const DUMMY = 'no handler';
    expect(mention.apply(DUMMY, stock, false)).toBe(DUMMY);
    // dropping the trailing space is an edit: it reaches the anchor (and fails
    // here, there being none) instead of short-circuiting
    expect(mention.apply(DUMMY, stock.trimEnd(), false)).toBeNull();
    const mcpStock = sub('mcp-instructions', mcpInstructions.defaultBody);
    expect(
      mcpInstructions.apply(
        MCP_2291,
        mcpStock.replace(/\n/g, '\r\n') + '\r\n',
        false
      )
    ).toBe(MCP_2291);
  });
});

describe('second review fixes', () => {
  it('a CRLF-saved .md renders single line breaks and drops blank lines cleanly', () => {
    const md =
      '<!--\r\nname: MCP\r\n-->\r\nIntro\r\n\r\n{{added_section}}\r\n\r\n{{removed_section}}\r\nEnd\r\n';
    const parsed = parseReminderMarkdown('mcp-instructions', md);
    expect(parsed.body).not.toContain('\r');
    const r = runCase(
      mcpInstructions.apply(
        MCP_2291,
        sub('mcp-instructions', parsed.body),
        false
      )!,
      'mcp_instructions_delta'
    );
    expect(
      r({ addedBlocks: ['## a\nA'], addedNames: ['a'], removedNames: [] })
    ).toBe(
      'Intro\n\n# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## a\nA\n\nEnd'
    );
  });

  it('pdf-reference re-applies over its own empty-aware emit', () => {
    const first = pdfRef.apply(
      MOCK_PDF_BLOCK,
      sub('pdf-reference', 'PDF {{filename}}\n{{model_refused_note}}'),
      false
    )!;
    expect(first).toContain('return ((c)=>c.trim()===""?[]:gc(');
    expect(
      pdfRef.apply(
        first,
        sub('pdf-reference', 'PDF {{filename}}\n{{model_refused_note}}'),
        false
      )
    ).toBe(first);
    const second = pdfRef.apply(
      first,
      sub(
        'pdf-reference',
        'Edited {{filename}} ({{page_count_text}})\n{{model_refused_note}}'
      ),
      false
    )!;
    expect(second).not.toBeNull();
    expect(second).toContain('Read the whole file with the ${nt} tool.');
    const start = second.indexOf('pdf_reference:');
    const fn = new Function(
      'ou',
      'Mt',
      'nt',
      'P',
      'gc',
      'Ce',
      `return ({${second.slice(start, second.indexOf(',selected_lines_in_ide:'))}}).pdf_reference`
    )(
      (x: string) => x,
      (x: number) => `${x}B`,
      'Read',
      (n: number, w: string) => (n === 1 ? w : w + 's'),
      (x: unknown) => x,
      (o: { content: string }) => o.content
    ) as (e: Record<string, unknown>) => string[];
    expect(fn({ filename: 'a', pageCount: 7, fileSize: 9 })).toEqual([
      'Edited a (7 pages)',
    ]);
    expect(
      fn({
        filename: 'a',
        pageCount: 7,
        fileSize: 9,
        wholeRefusedByModel: true,
      })
    ).toEqual(['Edited a (7 pages)\nNo PDF; pages: "1-7".']);
    // pristine's "too large" alternate is gone from that output: binding
    // {{unreadable_reason}} there fails loud instead of rendering it empty
    expect(
      pdfRef.apply(
        first,
        sub('pdf-reference', 'x {{unreadable_reason}}'),
        false
      )
    ).toBeNull();
  });
});
