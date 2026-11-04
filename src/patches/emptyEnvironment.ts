import { showDiff } from './index';

export function suppressEmptyEnvironment(
  parts: unknown[],
  rendered: string
): string {
  return parts.every(part => typeof part === 'string' && !part.trim())
    ? ''
    : rendered;
}

export const writeEmptyEnvironment = (file: string): string | null => {
  const source = suppressEmptyEnvironment.toString();
  const helper = `function __tweakccEmptyEnvironment${source.slice(source.indexOf('('))}`;
  const pattern =
    /[;,](?:return)?(\[([$\w]+),\.\.\.([$\w]+)\(([$\w]+)\)\]\.join\(`\n`\))/g;
  const matches = [...file.matchAll(pattern)].filter(match => {
    const heading = match[2].replace(/\$/g, '\\$');
    return new RegExp(`(?:var |[,;])${heading}="# Environment"[,;]`).test(file);
  });
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      'patch: emptyEnvironment: failed to find unique environment composer'
    );
    return null;
  }
  const match = matches[0];
  const replacement = `(${helper})(${match[4]},${match[1]})`;
  const start = match.index + match[0].length - match[1].length;
  const prefix = `(${helper})(${match[4]},`;
  if (file.slice(start - prefix.length, start) === prefix) return file;
  const end = start + match[1].length;
  const updated = file.slice(0, start) + replacement + file.slice(end);
  showDiff(file, updated, replacement, start, end);
  return updated;
};
