import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findSettingsDescriptions,
  buildSettingsIndex,
  matchesRendered,
} = require('./settingsSchema.cjs');

// A virtual bundle in the extractor's shape: modules behind sentinel comments.
const bundle = modules =>
  modules
    .map(
      (src, i) => `\n/*@@TWEAKCC_MODULE:${i}:/$bunfs/root/m${i}.js@@*/\n${src}`
    )
    .join('');

const ROOT_KEYS =
  '$schema:o().describe("Schema ref"),apiKeyHelper:o(),cleanupPeriodDays:A(),' +
  'env:o(),model:o(),statusLine:o(),enabledPlugins:o(),outputStyle:o(),';

const settingsModule = `import{hk}from"/$bunfs/root/m1.js";
var o=()=>({describe(){return this},optional(){return this}}),A=o,u=(x)=>x;
var lazy=f(()=>hk());
var NOTE="Project settings are ignored.";
function build(e){return u({${ROOT_KEYS}
  permissions:u({allow:o().describe("Rules that allow a tool")}).describe("Permission rules"),
  hooks:lazy.optional().describe("Hook commands"),
  secret:u({inner:o().describe("never sent")}).describe("@internal Hidden setting"),
  excluded:o().describe("Commands that run outside the sandbox. "+NOTE),
  long:o().describe("First half of a long description, " + 'second half in single quotes'),
  spell:o().describe(\`Pick one of \${list.join(", ")} or auto\`),
  ...gate&&{gated:o().describe("Only with the env flag")}})}`;

const hooksModule = `function hk(){return u({hooks:k(z([
  u({type:R("command"),timeout:A().describe("Command timeout")}),
  u({type:R("http"),timeout:A().describe("HTTP timeout")})
]))})}
export{hk};`;

const unrelated = `var other=o().describe("Unrelated SDK field");`;

describe('findSettingsDescriptions', () => {
  const code = bundle([settingsModule, hooksModule, unrelated]);
  const { root, descriptions } = findSettingsDescriptions(code);
  const byText = t => descriptions.find(d => d.joined === t);

  it('finds the root by its quorum of setting names', () => {
    expect(root).not.toBeNull();
  });

  it('records key paths for direct children', () => {
    expect(byText('Rules that allow a tool').keyPath).toBe('permissions.allow');
    expect(byText('Permission rules').keyPath).toBe('permissions');
  });

  it('follows lazy wrappers and imports into other modules', () => {
    expect(byText('Command timeout')).toBeDefined();
  });

  it('names union members by their literal discriminator', () => {
    expect(byText('Command timeout').keyPath).toBe(
      'hooks.hooks.(command).timeout'
    );
    expect(byText('HTTP timeout').keyPath).toBe('hooks.hooks.(http).timeout');
  });

  it('drops an @internal property together with its subtree', () => {
    expect(byText('@internal Hidden setting')).toBeUndefined();
    expect(byText('never sent')).toBeUndefined();
  });

  it('follows an identifier operand to its literal declaration', () => {
    const d = descriptions.find(x => x.keyPath === 'excluded');
    expect(d.joined).toBe(
      'Commands that run outside the sandbox. Project settings are ignored.'
    );
    expect(d.fragments).toHaveLength(2);
    for (const f of d.fragments) {
      expect(code.slice(f.start + 1, f.end - 1)).toBe(f.value);
    }
  });

  it('keeps each `+` fragment at its own range', () => {
    const d = descriptions.find(x => x.keyPath === 'long');
    expect(d.fragments).toHaveLength(2);
    expect(d.joined).toBe(
      'First half of a long description, second half in single quotes'
    );
    for (const f of d.fragments) {
      expect(code.slice(f.start + 1, f.end - 1)).toBe(f.value);
    }
  });

  it('marks descriptions behind an env-gated spread', () => {
    expect(byText('Only with the env flag').gated).toBe(true);
    expect(byText('Permission rules').gated).toBe(false);
  });

  it('ignores describe calls the schema does not reach', () => {
    expect(byText('Unrelated SDK field')).toBeUndefined();
  });

  it('matches a rendered template with its interpolation as a wildcard', () => {
    const d = descriptions.find(x => x.keyPath === 'spell');
    expect(matchesRendered(d, 'Pick one of "a", "b" or auto')).toBe(true);
    expect(matchesRendered(d, 'Pick two of "a" or auto')).toBe(false);
  });
});

describe('buildSettingsIndex', () => {
  it('marks a fragment unsafe when its text also occurs outside the schema', () => {
    const code = bundle([
      settingsModule,
      hooksModule,
      `var dup="Rules that allow a tool";`,
    ]);
    const index = buildSettingsIndex(code);
    const entries = [...index.values()];
    const allow = entries.find(e => e.keyPath === 'permissions.allow');
    expect(allow.safe).toBe(false);
    expect(entries.find(e => e.keyPath === 'permissions').safe).toBe(true);
  });

  it('counts an escaped spelling elsewhere as a match', () => {
    const code = bundle([
      settingsModule,
      hooksModule,
      `var dup="Rules that allow a tool\\u0020";`,
    ]);
    const allow = [...buildSettingsIndex(code).values()].find(
      e => e.keyPath === 'permissions.allow'
    );
    expect(allow.matches).toBe(2);
  });
});

describe('findSettingsDescriptions — factory flag arms', () => {
  // CC builds two schemas from one factory: `ar(!1)` for settings and
  // `ar(!0)` for known_marketplaces.json. Only the settings arm is sent.
  const mod = `var o=()=>({describe(){return this}}),u=(x)=>x,f=(g)=>g;
function ar(e){return u({name:e?o().describe("Stored-file arm"):o().describe("Settings arm")})}
var Me=f(()=>ar(!1)),zd=f(()=>ar(!0));
function build(){return u({${ROOT_KEYS}market:Me})}`;
  const { descriptions } = findSettingsDescriptions(bundle([mod]));
  const texts = descriptions.map(d => d.joined);

  it('walks only the arm the settings call site selects', () => {
    expect(texts).toContain('Settings arm');
    expect(texts).not.toContain('Stored-file arm');
  });
});
