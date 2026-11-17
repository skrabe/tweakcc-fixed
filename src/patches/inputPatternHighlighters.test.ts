import { describe, expect, it, vi } from 'vitest';

import { InputPatternHighlighter } from '../types';
import { writeInputPatternHighlighters } from './inputPatternHighlighters';

vi.mock('./index', async () => {
  const actual = await vi.importActual<typeof import('./index')>('./index');
  return {
    ...actual,
    findChalkVar: () => 'chalk',
    showDiff: vi.fn(),
  };
});

const baseHighlighter = (
  overrides: Partial<InputPatternHighlighter>
): InputPatternHighlighter => ({
  name: 'test',
  regex: 'ok',
  regexFlags: 'g',
  format: '{MATCH}',
  styling: [],
  foregroundColor: '#ffffff',
  backgroundColor: null,
  enabled: true,
  ...overrides,
});

describe('writeInputPatternHighlighters', () => {
  it('skips invalid user regexes and still emits valid highlighters', () => {
    const input =
      'let props={inputValue:inputText,other:1};' +
      'return R.createElement(T,{key:E,color:N.highlight?.color,dimColor:N.highlight?.dimColor,inverse:N.highlight?.inverse},R.createElement(I,null,N.text));' +
      ';let ranges=React.useMemo(()=>{let arr=[];if(a&&b&&!c)arr.push({start:s,end:s+l.length,color:"warning",priority:1})},[]);';

    const result = writeInputPatternHighlighters(input, [
      baseHighlighter({ name: 'broken', regex: '[', regexFlags: 'g' }),
      baseHighlighter({ name: 'valid', regex: 'todo', regexFlags: '' }),
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain('matchAll(new RegExp("todo", "g"))');
    expect(result).not.toContain('new RegExp("["');
  });

  // CC >=2.1.186 migrated the UI bundle from React.createElement to the jsx
  // runtime: children move into a `children:` prop and the key becomes the
  // third jsx() argument.
  const jsxRenderer =
    'return jte.jsx(h,{color:SYe.highlight?.color,' +
    'dimColor:SYe.highlight?.dimColor,inverse:SYe.highlight?.inverse,' +
    'children:jte.jsx(Ac,{children:SYe.text})},fVy);';

  // A real chalk binding, so the resolver runs for real. The mocked
  // findChalkVar is bypassed by design on the module-local path.
  const CHALK_DECL = 'var chalk=chalkFactory();chalk.hex("#fff").bold("x");';

  const jsxFile =
    CHALK_DECL +
    'let props={inputValue:te,other:1};' +
    jsxRenderer +
    ';let ranges=Pi.useMemo(()=>{let arr=[];if(a&&b&&!c)' +
    'arr.push({start:s,end:s+l.length,color:"warning",priority:20})},[a]);';

  const importedJsxRenderer =
    'return c(u,{color:C.highlight?.color,dimColor:C.highlight?.dimColor,' +
    'inverse:C.highlight?.inverse,underline:C.highlight?.underline,' +
    'children:c(E,{children:C.text})},Pt);';

  const importedJsxFile =
    CHALK_DECL +
    'let props={inputValue:te,other:1};' +
    importedJsxRenderer +
    ';let ranges=z(()=>{let arr=[];if(a&&b&&!c)' +
    'arr.push({start:s,end:s+l.length,color:"warning",priority:20})},[a]);';

  it('patches the imported jsx renderer shape (CC >=2.1.246)', () => {
    const result = writeInputPatternHighlighters(importedJsxFile, [
      baseHighlighter({ name: 'todo', regex: 'TODO', styling: ['bold'] }),
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain('return c(u,{');
    expect(result).not.toContain('.jsx(');
    expect(result).toContain('matchAll(new RegExp("TODO", "g"))');
    expect(result).toContain('style:(x)=>chalk.bold(x)');
    expect(result).toContain(',[a,te]);');
  });

  it('keeps leading literal Text props on the renderer (CC >=2.1.326)', () => {
    const renderer =
      'return e(n,{dangerouslyAllowHiddenCharacters:!0,' +
      'color:Q.highlight?.color,backgroundColor:Q.highlight?.backgroundColor,' +
      'dimColor:Q.highlight?.dimColor,bold:Q.highlight?.bold,' +
      'strikethrough:Q.highlight?.strikethrough,' +
      'children:e(Hn,{children:Q.text})},re)';
    const file =
      CHALK_DECL +
      'let props={inputValue:te,other:1};' +
      renderer +
      ';let ranges=z(()=>{let arr=[];if(a&&b&&!c)' +
      'arr.push({start:s,end:s+l.length,color:"warning",priority:20})},[a]);';

    const result = writeInputPatternHighlighters(file, [
      baseHighlighter({ name: 'todo', regex: 'TODO', styling: ['bold'] }),
    ]);

    expect(result).not.toBeNull();
    expect(result).not.toContain(renderer);
    expect(result).toContain(
      'return e(n,{dangerouslyAllowHiddenCharacters:!0,color:(Q.highlight?.style??'
    );
    expect(result).toContain(',dimColor:Q.highlight?.dimColor,');
    expect(result).toContain(
      'children:e(Hn,{children:(Q.highlight?.style??(typeof Q.highlight?.color==="function"?' +
        'Q.highlight.color:void 0))?(Q.highlight?.style??(typeof Q.highlight?.color==="function"?' +
        'Q.highlight.color:void 0))(Q.text):Q.text})},re)'
    );
    expect(result).toContain('matchAll(new RegExp("TODO", "g"))');

    const twice = writeInputPatternHighlighters(result as string, [
      baseHighlighter({ name: 'todo', regex: 'TODO' }),
    ]);
    expect(
      (twice as string).split('dangerouslyAllowHiddenCharacters:!0').length - 1
    ).toBe(1);
  });

  it('patches the jsx-runtime renderer shape (CC >=2.1.186)', () => {
    const result = writeInputPatternHighlighters(jsxFile, [
      baseHighlighter({ name: 'todo', regex: 'TODO', styling: ['bold'] }),
    ]);

    expect(result).not.toBeNull();
    // Renderer: styling props forwarded, key kept as the third jsx() argument,
    // and the text run through the chalk `style` fn when one is present.
    expect(result).toContain(
      'children:jte.jsx(Ac,{children:(SYe.highlight?.style??' +
        '(typeof SYe.highlight?.color==="function"?SYe.highlight.color:void 0))' +
        '?(SYe.highlight?.style??(typeof SYe.highlight?.color==="function"?' +
        'SYe.highlight.color:void 0))(SYe.text):SYe.text})},fVy)'
    );
    for (const prop of [
      'backgroundColor',
      'inverse',
      'bold',
      'italic',
      'underline',
      'strikethrough',
    ]) {
      expect(result).toContain(`,${prop}:(SYe.highlight?.style??`);
    }
    // dimColor is forwarded unconditionally — a chalk style fn can't express it.
    expect(result).toContain(',dimColor:SYe.highlight?.dimColor,');
    // The pristine renderer must be gone, and no createElement shape invented.
    expect(result).not.toContain(jsxRenderer);
    expect(result).not.toContain('createElement');
    // Highlighter push + dependency-array wiring still land.
    expect(result).toContain('matchAll(new RegExp("TODO", "g"))');
    expect(result).toContain(
      'color:"#ffffff",bold:!0,style:(x)=>chalk.bold(x)'
    );
    expect(result).toContain(',[a,te]);');
  });

  it('re-applying the jsx renderer patch is a no-op', () => {
    const once = writeInputPatternHighlighters(jsxFile, [
      baseHighlighter({ name: 'todo', regex: 'TODO' }),
    ]);
    expect(once).not.toBeNull();

    const twice = writeInputPatternHighlighters(once as string, [
      baseHighlighter({ name: 'todo', regex: 'TODO' }),
    ]);
    // The renderer half must not fail (or double-splice) on an already
    // patched file.
    expect(twice).not.toBeNull();
    expect(
      (twice as string).split('children:jte.jsx(Ac,{children:(').length - 1
    ).toBe(1);
  });
});

// CC 2.1.246 code-split the bundle. `findChalkVar` counts across the whole
// file, so it returns whichever module uses chalk most — and splicing that
// name into a DIFFERENT module throws the first time a highlighter matches
// what the user is typing. Against the real 2.1.246 bundle it picked `b`,
// which in the target module is only ever a block-local loop variable.
describe('module-local chalk resolution (code-split bundles)', () => {
  const MARK = (i: number, n: string) => `\n/*@@TWEAKCC_MODULE:${i}:${n}@@*/\n`;

  // A chalk-heavy module that is NOT the one being patched; `b` wins a
  // bundle-wide count purely on volume.
  const LOUD_CHALK_MODULE =
    MARK(1, 'other.js') +
    'var b=chalkFactory();' +
    Array.from({ length: 40 }, (_, i) => `b.rgb(${i},0,0).bold("x");`).join('');

  const targetModule = (chalkDecl: string) =>
    MARK(2, 'input.js') +
    chalkDecl +
    'let props={inputValue:te,other:1};' +
    'return c(u,{color:C.highlight?.color,dimColor:C.highlight?.dimColor,' +
    'inverse:C.highlight?.inverse,children:c(E,{children:C.text})},Pt);' +
    ';let ranges=z(()=>{let arr=[];if(a&&q&&!w)' +
    'arr.push({start:s,end:s+l.length,color:"warning",priority:20})},[a]);';

  it('uses the chalk name bound in the patched module, not the loudest one', () => {
    const file =
      LOUD_CHALK_MODULE +
      targetModule('var oc=chalkFactory();oc.hex("#fff").bold("y");');
    const out = writeInputPatternHighlighters(file, [
      baseHighlighter({ name: 'todo', regex: 'todo', styling: ['bold'] }),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain('style:(x)=>oc.');
    expect(out).not.toContain('style:(x)=>b.');
  });

  it('drops the style closure when the patched module has no chalk at all', () => {
    const file = LOUD_CHALK_MODULE + targetModule('');
    const out = writeInputPatternHighlighters(file, [
      baseHighlighter({
        name: 'todo',
        regex: 'todo',
        styling: ['bold'],
        foregroundColor: '#ff0000',
      }),
    ]);
    expect(out).not.toBeNull();
    // No chain is better than a foreign name: the declarative props carry
    // every option this config exposes and the renderer falls back to them.
    expect(out).not.toContain('style:(x)=>');
    expect(out).toContain('color:"#ff0000",bold:!0,priority:100');
  });
});
