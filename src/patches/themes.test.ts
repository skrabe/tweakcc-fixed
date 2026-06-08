import { describe, it, expect } from 'vitest';
import { writeThemes } from './themes';
import { Theme } from '../types';

const theme: Theme = {
  name: 'Neon',
  id: 'neon',
  colors: { autoAccept: '#0f0', text: '#fff' } as unknown as Theme['colors'],
};

// Minimal cli.js shape carrying the three theme locations the patch rewrites:
// the color switch, the options array, and the name-mapping object (`hM3={...}`).
const cli =
  'switch(Z){case"light":return AA;case"dark":return BB;default:return CC};' +
  'X=[{label:"Dark mode",value:"dark"},{label:"Light mode",value:"light"}];' +
  'hM3={auto:"Auto (match terminal)",dark:"Dark mode"};' +
  'render=()=>hM3[sel.value.toString()]??sel.value.toString()';

describe('themes patch', () => {
  it('preserves the name-map assignment prefix (hM3=) instead of rewriting it to return{...}', () => {
    // Regression guard: a non-capturing prefix group made objMatch[1] undefined,
    // objPrefix defaulted to `return`, and `hM3={...}` became `return{...}` —
    // leaving hM3 undefined so `/config` crashed with
    // "undefined is not an object (evaluating 'hM3[...]')".
    const out = writeThemes(cli, [theme]);
    expect(out).not.toBeNull();
    expect(out).toMatch(/hM3=\{/); // binding preserved
    expect(out).not.toMatch(/[;}]return\{"neon"/); // not rewritten to an orphan return{...}
    expect(out).toContain('"neon":"Neon"'); // user theme injected into the map
  });
});
