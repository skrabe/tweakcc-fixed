import fs from 'node:fs';
import path from 'node:path';

const HEADER_END = '-->\n';
const PER_CLASS = 3;

const splitStub = text => {
  const at = text.indexOf(HEADER_END);
  return at === -1
    ? { header: '', body: text }
    : {
        header: text.slice(0, at + HEADER_END.length),
        body: text.slice(at + HEADER_END.length),
      };
};

const isPlainText = body =>
  /^[\x20-\x7e]+$/.test(body) && !/[`"'\\$]/.test(body);

const isPlain = body =>
  body.length >= 60 && body.length <= 400 && isPlainText(body);

export const buildEditShapeSet = ({
  stubsDir,
  promptsFile,
  outDir,
  pristineFile,
}) => {
  const pristine = fs.readFileSync(pristineFile, 'utf8');
  fs.cpSync(stubsDir, outDir, { recursive: true });
  const { prompts } = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  const sites = new Map();
  const firstOrder = new Map();
  const lastOrder = new Map();
  prompts.forEach((prompt, order) => {
    sites.set(prompt.id, (sites.get(prompt.id) ?? 0) + 1);
    if (!firstOrder.has(prompt.id)) firstOrder.set(prompt.id, order);
    lastOrder.set(prompt.id, order);
  });
  const hasIdentifiers = new Set(
    prompts
      .filter(p => p.identifierMap && Object.keys(p.identifierMap).length > 0)
      .map(p => p.id)
  );
  const stubs = new Map();
  for (const id of [...firstOrder.keys()]) {
    const file = path.join(outDir, `${id}.md`);
    if (!fs.existsSync(file)) continue;
    const { header, body } = splitStub(fs.readFileSync(file, 'utf8'));
    stubs.set(id, { file, header, body: body.replace(/\n$/, '') });
  }
  const byOrder = [...stubs.keys()].sort(
    (a, b) => firstOrder.get(a) - firstOrder.get(b)
  );
  const used = new Set();
  const write = (id, body) => {
    const stub = stubs.get(id);
    fs.writeFileSync(stub.file, `${stub.header}${body}\n`);
    used.add(id);
  };
  const manifest = {
    noop: [],
    malformed: [],
    unresolved: [],
    boundary: [],
    overlap: [],
  };

  for (const id of byOrder) {
    if (manifest.malformed.length >= PER_CLASS) break;
    if (used.has(id) || !hasIdentifiers.has(id)) continue;
    if (!stubs.get(id).body.includes('${')) continue;
    write(id, `${stubs.get(id).body} cost is \${100 for a run`);
    manifest.malformed.push(id);
  }
  for (const id of byOrder) {
    if (manifest.unresolved.length >= PER_CLASS) break;
    if (used.has(id) || !hasIdentifiers.has(id)) continue;
    write(id, `${stubs.get(id).body} \${EQ_HARNESS_UNKNOWN_NAME}`);
    manifest.unresolved.push(id);
  }

  const plainSingles = byOrder.filter(
    id => sites.get(id) === 1 && isPlain(stubs.get(id).body)
  );
  for (let i = 0; i + 1 < plainSingles.length; i += 2) {
    if (manifest.boundary.length >= PER_CLASS) break;
    const p = plainSingles[i];
    const q = plainSingles[plainSingles.length - 1 - i];
    if (p === q || used.has(p) || used.has(q)) continue;
    if (firstOrder.get(p) >= firstOrder.get(q)) continue;
    write(p, stubs.get(q).body);
    used.add(q);
    manifest.boundary.push({ p, q });
  }

  const enclosure = (outer, text) => {
    const at = outer.indexOf(text);
    const before = outer
      .slice(0, at)
      .split(/[`"'\\$\n{}]/)
      .pop();
    const after = outer.slice(at + text.length).split(/[`"'\\$\n{}]/)[0];
    if (before.length + after.length < 12) return null;
    let pristineCount = 0;
    let enclosed = 0;
    for (
      let hit = pristine.indexOf(text);
      hit !== -1;
      hit = pristine.indexOf(text, hit + 1)
    ) {
      pristineCount++;
      if (
        pristine.slice(hit - before.length, hit) === before &&
        pristine.slice(hit + text.length, hit + text.length + after.length) ===
          after
      )
        enclosed++;
    }
    return enclosed > 0 ? { pristineCount, enclosed } : null;
  };
  const inner = byOrder.filter(id => {
    const body = stubs.get(id).body;
    return body.length >= 30 && body.length <= 300 && isPlainText(body);
  });
  for (const b of inner) {
    if (manifest.overlap.length >= PER_CLASS) break;
    if (used.has(b)) continue;
    const text = stubs.get(b).body;
    let found = null;
    for (const id of byOrder) {
      if (id === b || used.has(id)) continue;
      if (lastOrder.get(id) >= firstOrder.get(b)) continue;
      const outer = stubs.get(id).body;
      if (outer.length <= text.length || !outer.includes(text)) continue;
      const counts = enclosure(outer, text);
      if (counts) {
        found = { a: id, ...counts };
        break;
      }
    }
    if (!found) continue;
    write(
      found.a,
      stubs.get(found.a).body.replace(text, 'EQ overlap replaced this text.')
    );
    write(b, `${text} EQ overlap edit.`);
    manifest.overlap.push({ b, ...found });
  }

  for (const id of byOrder) {
    if (manifest.noop.length >= PER_CLASS) break;
    if (used.has(id)) continue;
    write(id, stubs.get(id).body);
    manifest.noop.push(id);
  }
  return manifest;
};
