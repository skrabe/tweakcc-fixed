// Please see the note about writing patches in ./index

import { CUSTOM_MODELS } from '../customModels';
import { escapeIdent, showDiff } from './index';

const findCustomModelListInsertionPoint = (
  fileContents: string
): { insertionIndex: number; modelListVar: string } | null => {
  // 1. Find the custom model push pattern.
  // The lead boundary must NOT be a literal space: CC 2.1.197 restructured the
  // availableModels enumeration into a for-of loop so the push is now preceded by
  // `;` (`...continue;t.push({value:c,...})`) instead of a space. A negative
  // lookbehind on [$\w] captures the full list var regardless of the preceding
  // punctuation (`;`, ` `, `{`, `,`, …). The sibling opus[1m] helper push wraps its
  // arg as `.push(gda(s)??{value:...})`, so requiring `.push({value:` right after
  // the paren keeps this matching only the real model-list assembly site.
  //
  // `label:` and `description:` are EXPRESSIONS, not literals. CC 2.1.261 started
  // resolving a friendly label first, so the entry became
  // `{value:F,label:re??F,description:re===void 0?"Custom model":`Custom model (${F})`}`
  // — the old `label:[$\w]+,description:"Custom model"` pinned both to their 2.1.259
  // shapes and matched nothing. Anchor on the property NAMES plus the "Custom model"
  // literal wherever it appears in the description expression, and stop there rather
  // than matching to `})`: a template branch can contain `}` (`${F}`), so a
  // closing-brace anchor is a countdown, not a match.
  const pushPattern =
    /(?<![$\w])([$\w]+)\.push\(\{value:[$\w]+,label:[^,]{1,40},description:[^"]{0,40}"Custom model"/;
  const pushMatch = fileContents.match(pushPattern);
  if (!pushMatch || pushMatch.index === undefined) {
    console.error(
      'patch: findCustomModelListInsertionPoint: failed to find custom model push'
    );
    return null;
  }

  // 2. Extract the model list variable name
  const modelListVar = pushMatch[1];

  // The declaration/function head can move farther from the push site across CC builds
  // and when other patches expand this block (notably opusplan1m, which injects ~400
  // bytes BEFORE the custom-model push inside the same function), so keep a generous
  // lookback window. On CC 2.1.140 the head sits ~1500 bytes from the push BEFORE
  // opusplan1m runs and ~1530 bytes after, so 5000 leaves comfortable slack for
  // future CC builds and additional pre-patches.
  const searchStart = Math.max(0, pushMatch.index - 5000);
  const chunk = fileContents.slice(searchStart, pushMatch.index);

  // Declaration can be emitted as let/var/const depending on minifier output,
  // or as one variable in a comma-separated declaration list.
  const declPattern = `(?:(?:let|var|const) |,)${escapeIdent(modelListVar)}=.+?;`;
  const funcPattern = new RegExp(
    `function [$\\w]+\\([^)]*\\)\\{[\\s\\S]{0,5000}?${declPattern}`,
    'g'
  );
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(chunk)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    console.error(
      `patch: findCustomModelListInsertionPoint: failed to find function with ${modelListVar}`
    );
    return null;
  }

  // 5. Return index after the semicolon (end of the match), and the var name
  const insertionIndex = searchStart + lastMatch.index + lastMatch[0].length;
  return { insertionIndex, modelListVar };
};

export const writeModelCustomizations = (oldFile: string): string | null => {
  // Skip if custom models are already injected (e.g. from a previous
  // tweakcc run baked into the backup, or future native support).
  // The JSON.stringify format uses quoted keys: {"value":"claude-opus-4-6",...}
  if (oldFile.includes('"value":"claude-opus-4-6"')) {
    console.log(
      'patch: modelCustomizations: custom models already present — skipping'
    );
    return oldFile;
  }

  const found = findCustomModelListInsertionPoint(oldFile);
  if (!found) return null;

  const { insertionIndex, modelListVar } = found;

  // Build the injection: push each custom model onto the list
  const inject = CUSTOM_MODELS.map(
    model => `${modelListVar}.push(${JSON.stringify(model)});`
  ).join('');

  const newFile =
    oldFile.slice(0, insertionIndex) + inject + oldFile.slice(insertionIndex);
  showDiff(oldFile, newFile, inject, insertionIndex, insertionIndex);
  return newFile;
};
