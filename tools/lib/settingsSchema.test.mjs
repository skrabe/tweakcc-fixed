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

describe('findSettingsDescriptions — lazy field thunks', () => {
  // CC 2.1.284 hands the settings shape to a lazy field map: every property
  // is a thunk (`key:()=>schema`) resolved on first use, so the @internal
  // test must look through the thunk to the schema it returns.
  const thunkRoot = ROOT_KEYS.replace(/:(?=[oA]\()/g, ':()=>');
  const mod = `var o=()=>({describe(){return this},optional(){return this}}),A=o,u=(x)=>x;
function build(e){return{${thunkRoot}
  visible:()=>u({on:o().describe("Visible child")}).optional().describe("Visible parent"),
  quiet:()=>u({enabled:o().optional().describe("Quiet child"),start:o().describe("Quiet start")}).optional().describe("@internal Quiet hours"),
  flag:()=>o().optional().describe("@internal Hidden flag"),
  block:()=>{return o().describe("@internal Block-bodied thunk")},
  blockKid:()=>{return u({x:o().describe("Block child")}).describe("@internal Block parent")}}}`;
  const { root, descriptions } = findSettingsDescriptions(bundle([mod]));
  const texts = descriptions.map(d => d.joined);

  it('finds the root and keys paths through thunks', () => {
    expect(root).not.toBeNull();
    const d = descriptions.find(x => x.joined === 'Visible child');
    expect(d.keyPath).toBe('visible.on');
    expect(texts).toContain('Visible parent');
  });

  it('drops an @internal thunk property together with its subtree', () => {
    for (const t of [
      '@internal Quiet hours',
      'Quiet child',
      'Quiet start',
      '@internal Hidden flag',
      '@internal Block-bodied thunk',
      '@internal Block parent',
      'Block child',
    ]) {
      expect(texts).not.toContain(t);
    }
  });
});

describe('findSettingsDescriptions — @internal union options', () => {
  // CC 2.1.288 puts an @internal sentinel on a discriminated-union option
  // (`qo("source",[u({source:R("pluginDirectory")}).describe("@internal …"),
  // ...e.options])`). CC's stripper drops such an option from `anyOf`/`oneOf`
  // with its subtree, but leaves an @internal array item or tuple member in.
  const mod = `var o=()=>({describe(){return this},optional(){return this},or(){return this}}),u=(x)=>x,R=(x)=>x,f=(g)=>g;
function qo(e,t,r){return new Bi({type:"union",options:t,discriminator:e,...Ba(r)})}
function un(e,t){return new Bi({type:"union",options:e,...Ba(t)})}
function tu(e,t){return new Tu({type:"tuple",items:e,rest:t})}
function ar(e){return new Ar({type:"array",element:e})}
var src=f(()=>un([u({source:R("github"),repo:o().describe("GitHub repo")}),u({source:R("url"),url:o().describe("Marketplace URL")})]));
var hidden=f(()=>u({x:o().describe("Bound child")}).describe("@internal Bound option"));
function build(){return u({${ROOT_KEYS}
  blocked:ar(f(()=>{let e=src();return qo("source",[u({source:R("pluginDirectory"),dir:o().describe("Sentinel child")}).describe("@internal Policy-list sentinel"),...e.options])})()),
  plain:un([o().describe("Kept option"),hidden,o().optional().describe("@internal Chained option")]),
  either:o().describe("Left option").or(o().describe("@internal Right option")),
  items:ar(o().describe("@internal Array item")),
  pair:tu([o().describe("@internal Tuple member"),o().describe("Second member")])})}`;
  const { descriptions } = findSettingsDescriptions(bundle([mod]));
  const texts = descriptions.map(d => d.joined);

  it('drops an @internal union option together with its subtree', () => {
    for (const t of [
      '@internal Policy-list sentinel',
      'Sentinel child',
      '@internal Bound option',
      'Bound child',
      '@internal Chained option',
      '@internal Right option',
    ]) {
      expect(texts).not.toContain(t);
    }
  });

  it('keeps the sibling options', () => {
    for (const t of [
      'GitHub repo',
      'Marketplace URL',
      'Kept option',
      'Left option',
    ]) {
      expect(texts).toContain(t);
    }
  });

  it('keeps an @internal array item or tuple member, as CC does', () => {
    expect(texts).toContain('@internal Array item');
    expect(texts).toContain('@internal Tuple member');
    expect(texts).toContain('Second member');
  });
});

describe('findSettingsDescriptions — class-built union factories', () => {
  // CC 2.1.331's schema library builds nodes from classes: the imported
  // factory is `function $o(e,t,n){return new pe(e,t,n)}` and the union kind
  // is a `type` getter inherited from pe's base class, so the factory body
  // never spells `type:"union"`.
  const lib = `class Base{describe(){return this}optional(){return this}}
class Str extends Base{get type(){return"string"}}
class Obj extends Base{constructor(s){super();this.shape=s}get type(){return"object"}}
class Un extends Base{constructor(e,t){super();this.options=e}get type(){return"union"}}
class Disc extends Un{constructor(d,e,t){super(e,t);this.discriminator=d}}
class Tup extends Base{constructor(e){super();this.items=e}get type(){return"tuple"}}
function o(){return new Str}
function u(e){return new Obj(e)}
function x(e){return new Str}
function un(e,t){return new Un(e,t)}
function $o(e,t,n){return new Disc(e,t,n)}
function tu(e){return new Tup(e)}
export{o,u,x,un,$o,tu};`;
  const settings = `import{o,u,x,un,$o,tu}from"/$bunfs/root/m0.js";
var p=(g)=>g;
var at=p(()=>un([u({source:x("github"),repo:o().describe("GitHub repo")}),u({source:x("url"),url:o().describe("Marketplace URL")})]));
function lt(){return at()}
var Ima=p(()=>{let e=lt();return $o("source",[u({source:x("pluginDirectory"),dir:o().describe("Sentinel child")}).describe("@internal Policy-list sentinel"),...e.options])});
function build(){return u({${ROOT_KEYS}
  blocked:Ima(),
  pair:tu([o().describe("@internal Tuple member"),o().describe("Second member")])})}`;
  const { root, descriptions } = findSettingsDescriptions(
    bundle([lib, settings])
  );
  const texts = descriptions.map(d => d.joined);

  it('drops the @internal option of an imported class-built union', () => {
    expect(root).not.toBeNull();
    expect(texts).not.toContain('@internal Policy-list sentinel');
    expect(texts).not.toContain('Sentinel child');
  });

  it('still walks the spread options of the other union', () => {
    expect(texts).toContain('GitHub repo');
    expect(texts).toContain('Marketplace URL');
  });

  it('keeps an @internal member of a non-union class factory', () => {
    expect(texts).toContain('@internal Tuple member');
    expect(texts).toContain('Second member');
  });
});
