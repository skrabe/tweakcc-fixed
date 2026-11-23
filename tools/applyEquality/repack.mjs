import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , libPath, input, out, shape] = process.argv;
const lib = await import(pathToFileURL(libPath).href);

const ANCHOR = ' the ';

const reshape = (content, name) => {
  if (name === 'same') return content;
  const at = content.indexOf(ANCHOR);
  if (at === -1) throw new Error(`no "${ANCHOR}" in the extracted JS`);
  if (name === 'shrink-1') return content.slice(0, at) + content.slice(at + 1);
  const grow = /^grow-(\d+)$/.exec(name);
  if (!grow) throw new Error(`unknown shape ${name}`);
  const end = at + ANCHOR.length;
  return (
    content.slice(0, end) + ' '.repeat(Number(grow[1])) + content.slice(end)
  );
};

fs.copyFileSync(input, out);
const installation = { kind: 'native', path: out, version: '0.0.0' };
const { content, clearBytecode } = await lib.readContent(installation);
const edited = reshape(content, shape);
await lib.writeContent(installation, edited, clearBytecode);
console.log(
  JSON.stringify({
    shape,
    jsBytes: Buffer.byteLength(content),
    editedBytes: Buffer.byteLength(edited),
    clearBytecode,
  })
);
