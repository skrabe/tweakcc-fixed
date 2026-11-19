import { describe, it, expect } from 'vitest';

import { writeOutputStyleTurnReminder } from './outputStyleTurnReminder';

// The real shape from CC 2.1.231, minified names and all.
const RENDERER =
  'output_style:(e)=>{let t=xve[e.style];if(!t)return[];return vg([bn({content:`${t.name} output style is active. ${e.turnReminder??"Remember to follow the specific guidelines for this style."}`,isMeta:!0})])}';
const FILE = `var a=1;${RENDERER},critical_system_reminder:(e)=>0;var b=2;`;

describe('writeOutputStyleTurnReminder', () => {
  it('drops the guard that silently skips custom styles', () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    expect(out).not.toContain('if(!t)return[]');
    expect(out).toContain('outputStyleName_tweakcc');
  });

  it('falls back to the configured style name when the style is not built in', () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    // A built-in still uses its display name; a custom style uses e.style,
    // which is the name from settings.
    expect(out).toContain('t?.name??e.style');
  });

  it('still bails when there is no style at all, rather than emitting an empty reminder', () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    expect(out).toContain('if(!outputStyleName_tweakcc)return[]');
  });

  it("keeps a style's own turnReminder ahead of the default", () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    expect(out).toContain('e.turnReminder??');
  });

  it('states what to do rather than what not to do', () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    const added = out.slice(out.indexOf('output_style:'));
    // The Opus 5 card is specific that bare prohibitions get read as
    // conditional and reasoned past (pp.82-83, p.87), so the reminder must not
    // be phrased as one.
    expect(added).not.toMatch(/\bNEVER\b|\bDo not\b|\bDon't\b/);
    expect(out).toContain('Write this reply the way that style describes');
  });

  it('preserves the surrounding code', () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    expect(out.startsWith('var a=1;')).toBe(true);
    expect(out.endsWith('var b=2;')).toBe(true);
    expect(out).toContain('critical_system_reminder:(e)=>0');
  });

  it('tolerates minifier renames of every identifier it captures', () => {
    const renamed = FILE.replace(/xve/g, '$Q3')
      .replace(/\bvg\b/g, 'W$1')
      .replace(/\bbn\b/g, '$zz');
    const out = writeOutputStyleTurnReminder(renamed)!;
    expect(out).toBeTruthy();
    expect(out).toContain('$Q3[e.style]');
    expect(out).toContain('W$1([$zz(');
  });

  it('is idempotent: a second run is a no-op, not a double splice', () => {
    const once = writeOutputStyleTurnReminder(FILE)!;
    const twice = writeOutputStyleTurnReminder(once)!;
    expect(twice).toBe(once);
  });

  it('fails loudly when the renderer is gone', () => {
    expect(writeOutputStyleTurnReminder('var a=1;var b=2;')).toBeNull();
  });
});

describe('frontmatter turn-reminder threading', () => {
  // The two stock rebuilds that drop the key, shapes from CC 2.1.233.
  const LOADER =
    '({filePath:o,frontmatter:i,content:s,source:a,baseDir:l})=>{try{qCt("output-style",i);let u=tY.basename(o).replace(/\\.md$/,""),d=(i.name!=null?String(i.name):void 0)||u,p=Nce(i.description,u)??mKe(s,`x`),f=Nwe(i["keep-coding-instructions"]);return{name:d,description:p,prompt:s.trim(),source:a,baseDir:l,keepCodingInstructions:f}}catch(c){return null}}';
  const MERGE =
    'o[u.name]={name:u.name,description:u.description,prompt:u.prompt,source:u.source,keepCodingInstructions:u.keepCodingInstructions,forceForPlugin:u.forceForPlugin}';
  const FULL = `var a=1;${RENDERER},critical_system_reminder:(e)=>0;${LOADER};${MERGE};var b=2;`;

  it('threads the key through the custom-style loader return', () => {
    const out = writeOutputStyleTurnReminder(FULL)!;
    expect(out).toContain(
      'keepCodingInstructions:f,turnReminder:typeof i["turn-reminder"]==="string"?i["turn-reminder"]:typeof i.turnReminder==="string"?i.turnReminder:typeof i.turnreminder==="string"?i.turnreminder:void 0}'
    );
  });

  it('threads the key through the style-table merge', () => {
    const out = writeOutputStyleTurnReminder(FULL)!;
    expect(out).toContain(
      'forceForPlugin:u.forceForPlugin,turnReminder:u.turnReminder}'
    );
  });

  it('threads on the renderer-already-patched path too', () => {
    const once = writeOutputStyleTurnReminder(FULL)!;
    const rendererOnly = once
      .replace(
        /keepCodingInstructions:f,turnReminder:typeof[^}]+\}/,
        'keepCodingInstructions:f}'
      )
      .replace(',turnReminder:u.turnReminder}', '}');
    const out = writeOutputStyleTurnReminder(rendererOnly)!;
    expect(out).toContain('turnReminder:typeof i["turn-reminder"]');
    expect(out).toContain(',turnReminder:u.turnReminder}');
  });

  it('is idempotent across both threads', () => {
    const once = writeOutputStyleTurnReminder(FULL)!;
    const twice = writeOutputStyleTurnReminder(once)!;
    expect(twice).toBe(once);
    expect(twice.match(/,turnReminder:u\.turnReminder/g)).toHaveLength(1);
  });

  it('threads the merge when it carries extra fields (CC 2.1.328 syncedFolderId)', () => {
    const merge328 =
      'for(let K of z)for(let Q of K)y[Q.name]={name:Q.name,description:Q.description,prompt:Q.prompt,source:Q.source,keepCodingInstructions:Q.keepCodingInstructions,forceForPlugin:Q.forceForPlugin,syncedFolderId:Q.syncedFolderId};return y';
    const file = `var a=1;${RENDERER},critical_system_reminder:(e)=>0;${LOADER};${merge328};var b=2;`;
    const once = writeOutputStyleTurnReminder(file)!;
    expect(once).toContain(
      'y[Q.name]={name:Q.name,description:Q.description,prompt:Q.prompt,source:Q.source,keepCodingInstructions:Q.keepCodingInstructions,forceForPlugin:Q.forceForPlugin,syncedFolderId:Q.syncedFolderId,turnReminder:Q.turnReminder};return y'
    );
    const twice = writeOutputStyleTurnReminder(once)!;
    expect(twice).toBe(once);
    expect(twice.match(/,turnReminder:Q\.turnReminder/g)).toHaveLength(1);
  });

  it('still patches the renderer when the loader shapes are missing', () => {
    const out = writeOutputStyleTurnReminder(FILE)!;
    expect(out).toContain('outputStyleName_tweakcc');
    expect(out).not.toContain('turnReminder:typeof');
  });
});
