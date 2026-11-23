// Please see the note about writing patches in ./index
//
// Against Anthropic's first-party API, Claude Code marks the static part of its
// system prompt with `cache_control: {scope: "global"}`, a cache shared across
// accounts. Anthropic accepts that scope only when the system block before the
// marked one is one of Claude Code's own identity lines. With the identity line
// replaced, or removed, every request is refused before any model runs:
//
//     400 `cache_control.scope: "global"` is only valid when every preceding
//     block is also globally scoped. ...
//
// The identity line is all it checks: a replaced tool description, a different
// tool set, and edited text inside the marked block are accepted.
//
// The identity lines are the string literals of the set Claude Code's
// system-prompt split checks with `.has()`: the CLI line and the two Agent SDK
// lines, gathered into an array and a Set built from it.
//
// While they match the pristine bundle's, this patch leaves the bundle alone.
// Once an override has changed one, it turns off the predicate every
// global-scope decision reads: a function of no arguments that answers false
// unless two feature checks pass, and otherwise answers whether the API
// provider is first-party or Anthropic on AWS.
//
// The system prompt's split reads the predicate, as does a side query that
// builds its own marker from a call to it inside a `scope:` conditional.
// Answering false gives the identity line an organization-scoped breakpoint
// and merges the static and dynamic prompt parts into one organization-scoped
// block. The TTL and cache-scope request beta header stay the same.
//
// Names churn and repeat across modules, so the predicate is taken by its shape
// and by being the first function called in the split that reports
// "tengu_sysprompt_using_tool_based_cache". The side query cross-checks it
// when present; the identity set is the one checked after that telemetry call.

import { detachedSlice } from '../systemPromptSites';
import { debug } from '../utils';
import { showDiff } from './index';

const PREDICATE =
  /function ([$\w]+)\(\)\{if\(!([$\w]+)\(\)\)return!1;if\(!([$\w]+)\(\)\)return!1;let ([$\w]+)=([$\w]+)\(\);return \4==="firstParty"\|\|\4==="anthropicAws"\}/g;
const GLOBAL_SCOPE_CALLER = /scope:([$\w]+)\(\)\?"global"/g;
const SPLIT_TELEMETRY = '"tengu_sysprompt_using_tool_based_cache"';
const SPLIT_PREDICATE =
  /function [$\w]+\([$\w]+,[$\w]+\)\{let [$\w]+=([$\w]+)\(\),[$\w]+=[$\w]+\.findIndex\(/g;
const STOCK_IDENTITY_TEXTS = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
];
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/
  .source;

const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

/**
 * The source text of each identity literal, in the order of the array Claude
 * Code builds its identity set from, or null when the shape is not found.
 */
export const identityLiterals = (file: string): string[] | null => {
  const split = file.indexOf(SPLIT_TELEMETRY);
  if (split === -1) return null;
  const check = /else if\(([$\w]+)\.has\(/.exec(
    file.slice(split, split + 2000)
  );
  if (!check) return null;
  const declaration = new RegExp(
    `([$\\w]+)=\\[([$\\w]+(?:,[$\\w]+)*)\\],${escapeName(check[1])}=new Set\\(\\1\\)`
  ).exec(file);
  if (!declaration) return null;

  // Each member's literal is its nearest preceding declaration in the same
  // `var` chain, which sits directly before the array.
  const before = file.slice(
    Math.max(0, declaration.index - 20000),
    declaration.index
  );
  const literals: string[] = [];
  for (const member of declaration[2].split(',')) {
    const found = [
      ...before.matchAll(
        new RegExp(`(?:var |,)${escapeName(member)}=(${STRING_LITERAL})`, 'g')
      ),
    ].at(-1);
    if (!found) return null;
    literals.push(found[1]);
  }
  return literals;
};

export interface PristineIdentity {
  literals: string[] | null;
  hasStockTexts: boolean;
  text: string | null;
}

export const pristineIdentityOf = (pristineFile: string): PristineIdentity => {
  const literals =
    identityLiterals(pristineFile)?.map(literal =>
      detachedSlice(literal, 0, literal.length)
    ) ?? null;
  return {
    literals,
    hasStockTexts: STOCK_IDENTITY_TEXTS.every(text =>
      pristineFile.includes(text)
    ),
    text: literals ? null : pristineFile,
  };
};

export const writeNoGlobalCacheScope = (
  oldFile: string,
  pristineFile: string | PristineIdentity,
  identityOverrideApplied?: boolean
): string | null => {
  const pristine =
    typeof pristineFile === 'string'
      ? pristineIdentityOf(pristineFile)
      : pristineFile;
  const stock = pristine.literals;
  const current = identityLiterals(oldFile);
  const identityIsStock =
    stock && current
      ? stock.length === current.length &&
        stock.every((literal, i) => literal === current[i])
      : (pristine.text !== null && oldFile === pristine.text) ||
        (identityOverrideApplied !== true &&
          (!pristine.hasStockTexts ||
            STOCK_IDENTITY_TEXTS.every(text => oldFile.includes(text))));
  if (identityIsStock) {
    debug(
      'patch: noGlobalCacheScope: identity lines are stock; the global cache scope stays'
    );
    return oldFile;
  }

  const split = oldFile.indexOf(SPLIT_TELEMETRY);
  if (
    split === -1 &&
    !PREDICATE.test(oldFile) &&
    !GLOBAL_SCOPE_CALLER.test(oldFile)
  ) {
    debug('patch: noGlobalCacheScope: no global cache scope in this build');
    return oldFile;
  }
  PREDICATE.lastIndex = 0;
  GLOBAL_SCOPE_CALLER.lastIndex = 0;
  const splitStart = Math.max(0, split - 500);
  const splitMatches =
    split === -1
      ? []
      : [...oldFile.slice(splitStart, split).matchAll(SPLIT_PREDICATE)];
  if (splitMatches.length !== 1) {
    console.error(
      'patch: noGlobalCacheScope: failed to find the system-prompt split predicate'
    );
    return null;
  }
  const name = splitMatches[0][1];
  const callers = new Set(
    [...oldFile.matchAll(GLOBAL_SCOPE_CALLER)].map(m => m[1])
  );
  if (callers.size > 0 && (callers.size !== 1 || !callers.has(name))) {
    console.error(
      `patch: noGlobalCacheScope: scope:X()?"global" does not name the system-prompt split predicate ${name}`
    );
    return null;
  }

  const matches = [...oldFile.matchAll(PREDICATE)].filter(m => m[1] === name);
  if (matches.length === 0) {
    if (oldFile.includes(`function ${name}(){return!1}`)) {
      debug('patch: noGlobalCacheScope: predicate already answers false');
      return oldFile;
    }
    console.error(
      `patch: noGlobalCacheScope: failed to find the global-scope predicate ${name}`
    );
    return null;
  }
  if (matches.length > 1) {
    console.error(
      `patch: noGlobalCacheScope: the global-scope predicate ${name} matched ${matches.length} times`
    );
    return null;
  }

  const [match] = matches;
  const start = match.index!;
  const end = start + match[0].length;
  const replacement = `function ${name}(){return!1}`;
  const newFile = oldFile.slice(0, start) + replacement + oldFile.slice(end);
  showDiff(oldFile, newFile, replacement, start, end);
  return newFile;
};
