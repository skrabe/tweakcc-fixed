// Please see the note about writing patches in ./index

import { escapeIdent, showDiff } from './index';
import type { CustomModel } from '../types';

/** Re-export CustomModel for use by other modules */
export type { CustomModel };

// Built-in Claude models shipped with tweakcc. Each carries contextWindow and maxTokens
// so the runtime reader can merge them with user-defined models from settings.json.
// prettier-ignore
export const CUSTOM_MODELS: CustomModel[] = [
  { value: 'claude-opus-4-6',              label: 'Opus 4.6',             description: "Claude Opus 4.6 (February 2026)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-sonnet-4-6',            label: 'Sonnet 4.6',           description: "Claude Sonnet 4.6 (February 2026)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-haiku-4-5-20251001',    label: 'Haiku 4.5',            description: "Claude Haiku 4.5 (October 2025)", contextWindow: 65536, maxTokens: 32768 },
  { value: 'claude-opus-4-5-20251101',     label: 'Opus 4.5',             description: "Claude Opus 4.5 (November 2025)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-sonnet-4-5-20250929',   label: 'Sonnet 4.5',          description: "Claude Sonnet 4.5 (September 2025)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-opus-4-1-20250805',     label: 'Opus 4.1',             description: "Claude Opus 4.1 (August 2025)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-opus-4-20250514',      label: 'Opus 4',               description: "Claude Opus 4 (May 2025)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-sonnet-4-20250514',    label: 'Sonnet 4',             description: "Claude Sonnet 4 (May 2025)", contextWindow: 1000000, maxTokens: 32768 },
  { value: 'claude-3-7-sonnet-20250219',  label: 'Sonnet 3.7',           description: "Claude 3.7 Sonnet (February 2025)", contextWindow: 200000, maxTokens: 8192 },
  { value: 'claude-3-5-sonnet-20241022',  label: 'Sonnet 3.5 (October)', description: "Claude 3.5 Sonnet (October 2024)", contextWindow: 200000, maxTokens: 8192 },
  { value: 'claude-3-5-haiku-20241022',   label: 'Haiku 3.5',            description: "Claude 3.5 Haiku (October 2024)", contextWindow: 65536, maxTokens: 8192 },
  { value: 'claude-3-5-sonnet-20240620',  label: 'Sonnet 3.5 (June)',    description: "Claude 3.5 Sonnet (June 2024)", contextWindow: 200000, maxTokens: 8192 },
  { value: 'claude-3-haiku-20240307',     label: 'Haiku 3',              description: "Claude 3 Haiku (March 2024)", contextWindow: 65536, maxTokens: 8192 },
  { value: 'claude-3-opus-20240229',      label: 'Opus 3',               description: "Claude 3 Opus (February 2024)", contextWindow: 200000, maxTokens: 8192 },
];

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

/**
 * Inject a runtime settings reader at CC startup that loads per-model context windows
 * from ~/.claude/settings.json. Uses two formats for maximum compatibility:
 *
 * 1. Primary (recommended): "customModels" array — clean JSON objects
 *    { "customModels": [{ "value": "qwen36-500k:35b", "contextWindow": 500000 }] }
 *
 * 2. Fallback: modelOverrides strings with key=value format (works with CC's native modelOverrides)
 *    { "modelOverrides": { "my-model": ["contextWindow=500000"] } }
 *
 * This is dynamic — no re-patching needed when users add/remove models.
 */
const injectSettingsReader = (fileContents: string): string | null => {
  // Find server initialization point — where we can safely inject startup code
  const serverPattern = /server\s*=\s*globalThis\./;
  const srvMatch = fileContents.match(serverPattern);

  if (!srvMatch || srvMatch.index === undefined) {
    console.error(
      'patch: modelCustomizations: failed to find server initialization point for settings reader'
    );
    return null;
  }

  // Build the startup reader that reads ~/.claude/settings.json at CC boot.
  // Populates globalThis.__tweakccCustomModels from customModels array (primary)
  // and modelOverrides strings with contextWindow=... format (fallback).
  const readerFunc = `globalThis.__tweakccReadSettings=function(){var m=globalThis.__tweakccCustomModels;if(!m)m=[];try{var f=require("fs"),p=require("path");try{var c=p.join(p.homedir(),".claude","settings.json");var d=JSON.parse(f.readFileSync(c,"utf8"));if(d.customModels)for(var x of d.customModels){var already=m.some(function(e){return e.value===x.value});if(!already)m.push({value:x.value,label:x.label||x.value,description:"",contextWindow:x.contextWindow||200000,maxTokens:x.maxTokens||16384})}}catch(u){}try{var v=d&&d.modelOverrides;for(var k in v){var vals=v[k];if(Array.isArray(vals))for(var j=0;j<vals.length;j++){var parts=String(vals[j]).split("=");if(parts[0]==="contextWindow"){m=(m||[]).concat({value:k,label:k,description:"",contextWindow:Number(parts[1])||200000,maxTokens:16384})}}}}catch(t){}globalThis.__tweakccCustomModels=m};
  globalThis.__tweakccReadSettings();`;

  const newFile =
    fileContents.slice(0, srvMatch.index) + readerFunc + fileContents.slice(srvMatch.index);

  return newFile;
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

  // Build the injection: push each built-in Claude model onto the list.
  // JSON.stringify includes all properties (contextWindow, maxTokens), which our hF
  // calculation reads from globalThis.__tweakccCustomModels to drive per-model context
  // window enforcement via CLAUDE_CODE_CONTEXT_LIMIT check.
  const inject = CUSTOM_MODELS.map(
    model => `${modelListVar}.push(${JSON.stringify(model)});`
  ).join('');

  let patchedFile = oldFile.slice(0, insertionIndex) + inject + oldFile.slice(insertionIndex);

  // Also inject the runtime settings reader at server initialization point.
  // This reads ~/.claude/settings.json modelOverrides at CC boot so users can add/remove
  // Ollama/custom models by editing settings.json — no re-patch needed.
  const readerResult = injectSettingsReader(patchedFile);
  if (readerResult) {
    showDiff(
      patchedFile,
      readerResult,
      '\n  /* __tweakccReadSettings injected */',
      patchedFile.indexOf('server'),
      patchedFile.indexOf('server') + 100,
    );
    patchedFile = readerResult;
  }

  return patchedFile;
};
