import { debug, escapeNonAscii } from '../utils';
import { showDiff } from './index';

const MODELS = [
  ['opusrouter', 'claude-opus-5-5', 'Opus 5.5 + Effort Router'],
  ['fablerouter', 'claude-fable-5-1', 'Fable 5.1 + Effort Router'],
] as const;

const isRouter = (value: string): string =>
  `(${value}==="opusrouter"||${value}==="fablerouter")`;

const replace = (
  file: string,
  pattern: RegExp,
  replacement: (match: RegExpMatchArray) => string,
  name: string
): string | null => {
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(`patch: complexityRouterModels: failed to find ${name}`);
    return null;
  }
  const text = escapeNonAscii(replacement(match));
  const result =
    file.slice(0, match.index) +
    text +
    file.slice(match.index + match[0].length);
  showDiff(file, result, text, match.index, match.index + match[0].length);
  return result;
};

const patchEffortControls = (file: string): string | null => {
  const adjust =
    /(=[$\w]+\(\(([$\w]+)\)=>\{let ([$\w]+)=[$\w]+\(\),([$\w]+)=[$\w]+\.find\(\(([$\w]+)\)=>\5\.value===\3\);if\(\4===void 0\|\|\4\.disabled===!0\)return;)/;
  let result = replace(
    file,
    adjust,
    m => `${m[0]}if(${isRouter(m[3])})return;`,
    'picker effort adjustment'
  );
  if (result === null) return null;
  const display =
    /(([$\w]+)!==void 0&&![$\w]+&&[$\w]+\([$\w]+,\{marginBottom:1,flexDirection:"column",children:)/;
  const text = result.match(
    /([$\w]+)\(([$\w]+),\{color:"subtle",children:\[[$\w]+\([$\w]+,\{effort:void 0\}\)," Effort not supported"/
  );
  if (!text) return null;
  result = replace(
    result,
    display,
    m =>
      `${m[0]}${isRouter(m[2])}?${text[1]}(${text[2]},{color:"subtle",children:"Automatic effort"+(globalThis.__tweakccRouterState?.()?.effort?" · currently "+globalThis.__tweakccRouterState().effort:"")}):`,
    'picker effort display'
  );
  if (result === null) return null;
  const commit =
    /(function ([$\w]+)\(([$\w]+)\)\{)((?:if\(\3==="fableplan"\)\{[$\w]+\(\3,void 0\);return\})?let ([$\w]+)=[$\w]+\(\3\),(?:[$\w]+=[$\w]+\(\),)*[$\w]+=\5&&([$\w]+)!==void 0&&\6!=="ultracode"\?[$\w]+\(\6,\5\):\6;[$\w]+\("tengu_model_command_menu_effort")/;
  return replace(
    result,
    commit,
    m => {
      const tail = result!
        .slice(m.index! + m[0].length)
        .match(
          new RegExp(
            `^(?:(?!function )[^])*?if\\(${m[3].replace(/\$/g, '\\$')}===[$\\w]+\\)\\{([$\\w]+)\\(null,[$\\w]+\\);return\\}`
          )
        );
      if (!tail) throw new Error('Router picker apply call is missing');
      return `${m[1]}if(${isRouter(m[3])}){${tail[1]}(${m[3]},void 0);return}${m[4]}`;
    },
    'picker model commit'
  );
};

export const writeComplexityRouterModels = (oldFile: string): string | null => {
  if (oldFile.includes('globalThis.__tweakccRouterSelectedModel=function(')) {
    return oldFile;
  }
  if (!oldFile.includes('"claude-opus-5-5"')) {
    debug('patch: complexityRouterModels: verified models unavailable — no-op');
    return oldFile;
  }
  const aliasResolver = oldFile.match(
    /function ([$\w]+)\(([$\w]+)\)\{let [$\w]+=\2\.trim\(\)[\s\S]{0,120}?if\([$\w]+\(([$\w]+)\)\)switch\(\3\)\{/
  );
  if (!aliasResolver) return null;
  const cases = MODELS.map(
    ([alias, model]) => `case"${alias}":return"${model}";`
  ).join('');
  let file = replace(
    oldFile,
    /(\[(?:"[\w[\]]+",)*"opusplan"(?:,"[\w[\]]+")*\])(\s*,\s*[$\w]+\s*=\s*\["sonnet","opus","haiku")/,
    m => `${m[1].slice(0, -1)},"opusrouter","fablerouter"]${m[2]}`,
    'model alias whitelist'
  );
  if (file === null) return null;
  const aliasIndex = file.indexOf(aliasResolver[0]);
  const resolved = file.replace(aliasResolver[0], aliasResolver[0] + cases);
  showDiff(
    file,
    resolved,
    aliasResolver[0] + cases,
    aliasIndex,
    aliasIndex + aliasResolver[0].length
  );
  file = resolved;
  file = replace(
    file,
    /(function [$\w]+\([$\w]+\)\{let [$\w]+=[$\w]+\(\);switch\([$\w]+\)\{case"opus":return [$\w]+\([$\w]+\);)/,
    m => m[0] + cases,
    'builtin model defaults'
  );
  if (file === null) return null;
  file = replace(
    file,
    /function ([$\w]+)\(\)\{let ([$\w]+)=[$\w]+\(\);if\(\2!==void 0\)return [$\w]+\(\2,"explicit"\);return [$\w]+\(\)\}/,
    m =>
      `globalThis.__tweakccRouterSelectedModel=function(){let __tweakccSelected=${m[1]}();return __tweakccSelected==="opusrouter"?"claude-opus-5-5":__tweakccSelected==="fablerouter"?"claude-fable-5-1":null};${m[0]}`,
    'live selected model getter'
  );
  if (file === null) return null;
  for (const setter of [
    'overrideMainLoopModel',
    'replaceInitialMainLoopModel',
  ]) {
    file = replace(
      file,
      new RegExp(`(${setter}\\(([$\\w]+)\\)\\{this\\.#[$\\w]+=\\2)\\}`),
      m =>
        `${m[1]};queueMicrotask(()=>globalThis.__tweakccRouterSyncSelection?.())}`,
      'selected model setter'
    );
    if (file === null) return null;
  }
  file = replace(
    file,
    /function ([$\w]+)\(([$\w]+)=!1,([$\w]+)=null\)\{let ([$\w]+)=new Set,([$\w]+)=[$\w]+\(\2,\3\)\.filter\(\(([$\w]+)\)=>\{if\(\6\.value===null\)return!0;if\(\4\.has\(\6\.value\)\)/,
    m =>
      `function ${m[1]}(${m[2]}=!1,${m[3]}=null){let rows=__tweakccRouterBasePicker(${m[2]},${m[3]});let clean=rows.filter(row=>!${isRouter('row.value')});for(let [alias,model,label] of ${JSON.stringify(MODELS)}){let index=clean.findIndex(row=>typeof row.value==="string"&&row.disabled!==!0&&${aliasResolver[1]}(row.value)===model);if(index!==-1)clean.splice(index+1,0,{...clean[index],value:alias,label,description:"Automatic effort selected for each message"})}return clean}function __tweakccRouterBasePicker` +
      m[0].slice(`function ${m[1]}`.length),
    'filtered model picker'
  );
  if (file === null) return null;
  try {
    return patchEffortControls(file);
  } catch {
    console.error('patch: complexityRouterModels: failed to find picker apply');
    return null;
  }
};
