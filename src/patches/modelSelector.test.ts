import { describe, it, expect, vi } from 'vitest';
import { writeModelCustomizations, CUSTOM_MODELS } from './modelSelector';

// modelSelector injects extra Claude models into CC's model-picker list.
// The patch (a) finds the custom-model push site
//   `<var>.push({value:V,label:L,description:"Custom model"})`
// to learn the list variable name, then (b) walks back (<=5000 bytes) for the
// function whose body declares that variable
//   `function name(args){ ... let <var>=[...]; ... }`
// and splices a `<var>.push({...});` for each CUSTOM_MODELS entry right after
// the declaration's semicolon.
//
// FIXTURE mirrors that minified shape: a function that declares the list var
// `nQ` (with a comma-prefixed sibling, the `let `-prefixed form is also valid),
// later building the user's custom model and pushing it onto `nQ`.
// NOTE: the push-site regex requires a literal space before `<var>.push(` and
// identifier-only `value:`/`label:` operands, so the fixtures keep those spaces.
const FIXTURE =
  'q=1;function $Hk(B,Q){let aZ=B.foo,nQ=[{value:"claude-x",label:"X",description:"Built in"}];' +
  'if(Q){let mV=Q.model,nm=Q.name; nQ.push({value:mV,label:nm,description:"Custom model"})}return nQ}z=2;';

describe('writeModelCustomizations', () => {
  it('splices a push() for every CUSTOM_MODELS entry onto the discovered list var', () => {
    const out = writeModelCustomizations(FIXTURE);

    expect(out).not.toBeNull();
    // Discovered the list var (`nQ`) and emitted a push for each custom model,
    // each serialized via JSON.stringify (quoted keys).
    for (const model of CUSTOM_MODELS) {
      expect(out).toContain(`nQ.push(${JSON.stringify(model)});`);
    }
    // The marquee model id lands verbatim with the JSON.stringify quoting the
    // skip-guard later keys off of.
    expect(out).toContain('"value":"claude-opus-4-6"');
    // Injection sits right after the declaration's `;` and before the original
    // custom push (so the injected models are in the list when it's returned).
    const declEnd =
      out!.indexOf('description:"Built in"}];') +
      'description:"Built in"}];'.length;
    const injectAt = out!.indexOf('nQ.push({"value":"claude-opus-4-6"');
    const origPush = out!.indexOf('description:"Custom model"');
    expect(injectAt).toBe(declEnd); // spliced immediately after the declaration
    expect(injectAt).toBeLessThan(origPush);
  });

  it('honors the let/comma declaration via the `let `-prefixed form too', () => {
    // Same shape but the list var is the FIRST (let-prefixed) declarator.
    const fixture =
      'function r0(A){let nQ=[{value:"a",label:"A",description:"Built in"}],zz=1;' +
      ' nQ.push({value:x,label:y,description:"Custom model"});return nQ}';
    const out = writeModelCustomizations(fixture);
    expect(out).not.toBeNull();
    expect(out).toContain(`nQ.push(${JSON.stringify(CUSTOM_MODELS[0])});`);
  });

  it('keeps a `$`-bearing list var name intact (escapeIdent path)', () => {
    const fixture =
      'function f($a){let $L=[{value:"a",label:"A",description:"Built in"}];' +
      ' $L.push({value:x,label:y,description:"Custom model"});return $L}';
    const out = writeModelCustomizations(fixture);
    expect(out).not.toBeNull();
    expect(out).toContain(`$L.push(${JSON.stringify(CUSTOM_MODELS[0])});`);
  });

  it('produces valid JS injection (descriptions with special chars stay escaped)', () => {
    const out = writeModelCustomizations(FIXTURE)!;
    // The injected run sits between the declaration and the original `if(Q){`.
    // Slice exactly that run (all JSON.stringify'd pushes) and confirm it parses
    // as valid JS — proving descriptions with parens/dates stay properly quoted.
    const start = out.indexOf('nQ.push({"value":"claude-opus-4-6"');
    const injected = out.slice(start, out.indexOf('if(Q){', start));
    expect(() => new Function('nQ', injected)).not.toThrow();
    // Sanity: the run contains exactly one push per custom model.
    expect(injected.match(/nQ\.push\(\{/g)).toHaveLength(CUSTOM_MODELS.length);
  });

  it('is idempotent: returns the file unchanged when custom models already present', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const already =
      'x=1;nQ.push({"value":"claude-opus-4-6","label":"Opus 4.6","description":"d"});y=2;';
    expect(writeModelCustomizations(already)).toBe(already);
    logSpy.mockRestore();
  });

  it('returns null when the custom-model push site is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeModelCustomizations('function f(){let nQ=[];return nQ}')
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the push site exists but no declaring function is found', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Push present (with the required leading space), but `nQ` is never declared
    // inside a function within lookback -> the second null branch.
    const noDecl =
      'x=1; nQ.push({value:x,label:y,description:"Custom model"});';
    expect(writeModelCustomizations(noDecl)).toBeNull();
    errSpy.mockRestore();
  });
});
