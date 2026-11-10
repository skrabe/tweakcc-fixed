import { parseExpressionAt } from 'acorn';
import { escapeNonAscii } from '../utils';
import { showDiff } from './index';
import { normalizeRecordedPrompt } from './promptHygiene';
export { normalizeRecordedPrompt } from './promptHygiene';
import {
  FFF_BASH_GUIDANCE,
  FFF_OWNED_PROJECT_GUIDANCE,
  FFF_OWNED_TOOL_GUIDANCE_SUFFIXES,
} from './fffInstructionSuffixes';

export { FFF_BASH_GUIDANCE } from './fffInstructionSuffixes';

export function composeFffToolDescription(
  description: unknown,
  name: unknown,
  guidance: string
): unknown {
  if (name !== 'Bash' || typeof description !== 'string' || !guidance.trim()) {
    return description;
  }
  const suffix = '\n\n' + guidance;
  return description.replaceAll(suffix, '') + suffix;
}

export function normalizeFffAutoMode(
  messages: unknown,
  attachment: unknown,
  tools: unknown,
  guidance: string
): unknown {
  if (
    !Array.isArray(messages) ||
    typeof attachment !== 'object' ||
    attachment === null ||
    (attachment as Record<string, unknown>).type !== 'auto_mode' ||
    !Array.isArray(tools) ||
    !guidance.trim()
  ) {
    return messages;
  }
  if (
    !tools.some(
      tool =>
        typeof tool === 'object' &&
        tool !== null &&
        (tool as Record<string, unknown>).name === 'Bash'
    )
  )
    return messages;
  const replacement = 'search following the Bash tool description';
  let changed = false;
  const updated = messages.map(row => {
    if (typeof row !== 'object' || row === null) return row;
    const record = row as Record<string, unknown>;
    if (typeof record.message !== 'object' || record.message === null) {
      return row;
    }
    const message = record.message as Record<string, unknown>;
    let content = message.content;
    if (typeof content === 'string') {
      content = content.replace('search with grep and find', replacement);
      if (content === message.content) return row;
    } else if (Array.isArray(content)) {
      let contentChanged = false;
      content = content.map(block => {
        if (typeof block !== 'object' || block === null) return block;
        const value = block as Record<string, unknown>;
        if (value.type !== 'text' || typeof value.text !== 'string') {
          return block;
        }
        const text = value.text.replace(
          'search with grep and find',
          replacement
        );
        if (text === value.text) return block;
        contentChanged = true;
        return { ...value, text };
      });
      if (!contentChanged) return row;
    } else {
      return row;
    }
    changed = true;
    return { ...record, message: { ...message, content } };
  });
  return changed ? updated : messages;
}

export function normalizeFffRecordedTools(
  snapshot: unknown,
  suffixes: unknown
): unknown {
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof suffixes !== 'object' ||
    suffixes === null
  ) {
    return snapshot;
  }
  const record = snapshot as Record<string, unknown>;
  const owned = suffixes as Record<string, unknown>;
  let normalized: Record<string, unknown> | undefined;
  for (const field of ['toolDescriptions', 'toolEntries']) {
    const value = record[field];
    if (!(value instanceof Map)) continue;
    let updated: Map<unknown, unknown> | undefined;
    for (const name of ['Bash', 'Grep']) {
      const endings = owned[name];
      if (!Array.isArray(endings)) continue;
      const original: unknown = value.get(name);
      const entry =
        typeof original === 'object' && original !== null
          ? (original as Record<string, unknown>)
          : undefined;
      const description =
        field === 'toolEntries' ? entry?.description : original;
      if (typeof description !== 'string') continue;
      let text = description;
      for (const ending of endings) {
        if (typeof ending !== 'string' || ending.length === 0) continue;
        text = text.replaceAll(ending, '');
      }
      if (text === description) continue;
      updated ??= new Map<unknown, unknown>(value);
      updated.set(
        name,
        field === 'toolEntries' ? { ...entry, description: text } : text
      );
    }
    if (updated !== undefined) {
      normalized ??= { ...record };
      normalized[field] = updated;
    }
  }
  return normalized ?? snapshot;
}

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

type Scope = {
  header: RegExpMatchArray;
  start: number;
  end: number;
  declarations: AstNode[];
  assignments: AstNode[];
};

type Site = { start: number; end: number; replacement: string };

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AstNode).type === 'string' &&
  typeof (value as AstNode).start === 'number' &&
  typeof (value as AstNode).end === 'number';

const readScope = (file: string, pattern: RegExp): Scope | null => {
  const headers = [...file.matchAll(pattern)];
  if (headers.length !== 1 || headers[0].index === undefined) return null;
  const header = headers[0];
  const start =
    header.index! +
    header[0].indexOf(
      header[0].includes('async function') ? 'async function' : 'function'
    );
  let root: unknown;
  try {
    root = parseExpressionAt(file, start, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    });
  } catch {
    return null;
  }
  if (!isNode(root) || root.type !== 'FunctionExpression') return null;
  const declarations: AstNode[] = [];
  const assignments: AstNode[] = [];
  const pending: unknown[] = [root.body];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (!isNode(node)) continue;
    if (
      [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
      ].includes(node.type)
    ) {
      continue;
    }
    if (node.type === 'VariableDeclaration') declarations.push(node);
    if (node.type === 'AssignmentExpression') assignments.push(node);
    pending.push(...Object.values(node));
  }
  return {
    header,
    start: root.start,
    end: root.end,
    declarations,
    assignments,
  };
};

const serialize = (
  fn:
    | typeof normalizeRecordedPrompt
    | typeof composeFffToolDescription
    | typeof normalizeFffAutoMode
    | typeof normalizeFffRecordedTools,
  name: string
): string => {
  const source = fn.toString();
  return `function ${name}${source.slice(source.indexOf('('))}`;
};

const selectSite = (
  file: string,
  scope: Scope,
  pattern: RegExp,
  marker: string,
  helper: string,
  payload: unknown,
  expressions: (match: RegExpMatchArray) => {
    original: string;
    args: string[];
  },
  targetCapture = 1
): Site | null => {
  const candidates: Site[] = [];
  for (const declaration of scope.declarations) {
    if (!Array.isArray(declaration.declarations)) continue;
    for (const variable of declaration.declarations) {
      if (!isNode(variable) || !isNode(variable.id) || !isNode(variable.init)) {
        continue;
      }
      if (variable.id.type !== 'Identifier') continue;
      const init = variable.init;
      let original = init;
      const marked =
        init.type === 'CallExpression' &&
        isNode(init.callee) &&
        isNode(init.callee.id) &&
        init.callee.id.name === marker;
      if (marked) {
        if (!Array.isArray(init.arguments) || !isNode(init.arguments[0])) {
          continue;
        }
        original = init.arguments[0];
      }
      const native = file.slice(original.start, original.end);
      const canonical =
        file.slice(declaration.start, init.start) +
        native +
        file.slice(init.end, declaration.end);
      for (const match of canonical.matchAll(pattern)) {
        if (match[targetCapture] !== variable.id.name) continue;
        const values = expressions(match);
        if (native !== values.original) continue;
        const replacement = `(${helper})(${[
          native,
          ...values.args,
          escapeNonAscii(JSON.stringify(payload)),
        ].join(',')})`;
        if (marked && file.slice(init.start, init.end) !== replacement)
          continue;
        candidates.push({ start: init.start, end: init.end, replacement });
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
};

const API_SCOPE =
  /(?:^|[;}])async function\*([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let\{systemPrompt:[$\w]+,userContext:[$\w]+,systemContext:[$\w]+,canUseTool:/g;
// CC 2.1.299+ moved the query loop body into a nested generator.
const API_LOOP_SCOPE =
  /(?:^|[;}])async function\*([$\w]+)\(\)\{if\([$\w]+&&[$\w]+\.toolUseContext\.shouldStopBeforeNextApiCall\?\.\(\)\)return yield\*[$\w]+,\{reason:"background_requested"\};/g;
// CC 2.1.314+: a stop-hook early return precedes the background check.
const API_HOOK_LOOP_SCOPE =
  /(?:^|[;}])async function\*([$\w]+)\(\)\{if\([$\w]+\)return yield\*[$\w]+,[^;]*?\{reason:"hook_stopped"\};if\([$\w]+&&[$\w]+\.toolUseContext\.shouldStopBeforeNextApiCall\?\.\(\)\)return yield\*[$\w]+,\{reason:"background_requested"\};/g;
const readApiScope = (file: string): Scope | null =>
  readScope(file, API_HOOK_LOOP_SCOPE) ??
  readScope(file, API_LOOP_SCOPE) ??
  readScope(file, API_SCOPE);
// CC 2.1.322+: the context-usage function takes six parameters and its
// options destructure continues with `originalMessages:` instead of
// `mainThreadAgentDefinition:`.
const CONTEXT_SCOPE_2_1_322 =
  /(?:^|[;}])async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let\{session:[$\w]+,terminalWidth:[$\w]+,toolUseContext:[$\w]+,originalMessages:[$\w]+,/g;
const CONTEXT_SCOPE =
  /(?:^|[;}])async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let\{session:[$\w]+,terminalWidth:[$\w]+,toolUseContext:[$\w]+,mainThreadAgentDefinition:/g;
const readContextScope = (file: string): Scope | null =>
  readScope(file, CONTEXT_SCOPE_2_1_322) ?? readScope(file, CONTEXT_SCOPE);

export const writeFffInstructions = (
  file: string,
  guidance = FFF_BASH_GUIDANCE
): string | null => {
  const renderer =
    // CC 2.1.319+: the tools parameter lost its `=[]` default, a fifth
    // parameter follows, and the fold assignment ends the statement.
    readScope(
      file,
      /(?:^|[;}])function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{\2=([$\w]+)\(\2,\5\?\.accountMemoryWithheld,([$\w]+)\(\(\)=>\3\)\);let /g
    ) ??
    // CC 2.1.299+: the fold assignment continues with `,rows=next(rows);`.
    readScope(
      file,
      /(?:^|[;}])function ([$\w]+)\(([$\w]+),([$\w]+)=\[\],([$\w]+),([$\w]+)\)\{\2=([$\w]+)\(\2,\5\?\.accountMemoryWithheld,([$\w]+)\(\(\)=>\3\)\),\2=[$\w]+\(\2\);/g
    ) ??
    readScope(
      file,
      /(?:^|[;}])function ([$\w]+)\(([$\w]+),([$\w]+)=\[\],([$\w]+),([$\w]+)\)\{\2=([$\w]+)\(\2,\5\?\.accountMemoryWithheld,([$\w]+)\(\(\)=>\3\)\);/g
    );
  const descriptionPattern =
    /,([$\w]+)=\{name:([$\w]+)\.name,description:(([$\w]+)\?([$\w]+)\.description:([$\w]+)\?\.description\?\?([$\w]+)\.recordedDescription\?\?\5\.description),input_schema:/g;
  const descriptions = [...file.matchAll(descriptionPattern)];
  const descriptionHelper = serialize(
    composeFffToolDescription,
    '__tweakccFffDescription'
  );
  const markedPattern =
    /,[$\w]+=\{name:[$\w]+\.name,description:\(function __tweakccFffDescription\(/g;
  const marked = [...file.matchAll(markedPattern)];
  let descriptionSite: Site | null = null;
  if (descriptions.length === 1 && marked.length === 0) {
    const match = descriptions[0];
    const start =
      match.index! + match[0].indexOf('description:') + 'description:'.length;
    descriptionSite = {
      start,
      end: start + match[3].length,
      replacement: `(${descriptionHelper})(${match[3]},${match[2]}.name,${escapeNonAscii(JSON.stringify(guidance))})`,
    };
  } else if (descriptions.length === 0 && marked.length === 1) {
    const start =
      marked[0].index! +
      marked[0][0].indexOf('description:') +
      'description:'.length;
    try {
      const object = parseExpressionAt(
        file,
        marked[0].index! + marked[0][0].indexOf('{name:'),
        {
          ecmaVersion: 'latest',
        }
      ) as unknown;
      const property =
        isNode(object) && Array.isArray(object.properties)
          ? object.properties.find(
              (node: unknown) =>
                isNode(node) &&
                isNode(node.key) &&
                node.key.name === 'description'
            )
          : undefined;
      const expression =
        isNode(property) && isNode(property.value) ? property.value : undefined;
      if (expression) {
        const original = file.slice(start, expression.end);
        if (
          original.startsWith(`(${descriptionHelper})(`) &&
          original.endsWith(`,${escapeNonAscii(JSON.stringify(guidance))})`)
        ) {
          descriptionSite = {
            start,
            end: expression.end,
            replacement: original,
          };
        }
      }
    } catch {
      descriptionSite = null;
    }
  }
  const autoHelper = serialize(normalizeFffAutoMode, '__tweakccFffAutoMode');
  const sites = [
    descriptionSite,
    renderer &&
      selectSite(
        file,
        renderer,
        /([$\w]+)=([$\w]+)\?\.withoutAttachmentHooks\?([$\w]+)\(([$\w]+),([$\w]+)\):([$\w]+)\(\4,\5,([$\w]+)\),([$\w]+)=\1\.messages,\{isKnownType:([$\w]+),recordedRole:([$\w]+)\}=\1/g,
        '__tweakccFffAutoMode',
        autoHelper,
        guidance,
        match => ({
          original: `${match[1]}.messages`,
          args: [`${match[4]}.attachment`, renderer.header[3]],
        }),
        8
      ),
  ];
  if (sites.some(site => site === null)) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique scoped search instruction boundaries'
    );
    return null;
  }
  let updated = file;
  for (const site of (sites as Site[]).sort((a, b) => b.start - a.start)) {
    if (file.slice(site.start, site.end) === site.replacement) continue;
    const next =
      updated.slice(0, site.start) + site.replacement + updated.slice(site.end);
    showDiff(updated, next, site.replacement, site.start, site.end);
    updated = next;
  }
  return updated;
};

export const writeFffInstructionHygiene = (file: string): string | null => {
  if (!file.includes('prompt_snapshot')) return file;
  const api = readApiScope(file);
  const context = readContextScope(file);
  const marker = '__tweakccFffToolRecords';
  const helper = serialize(normalizeFffRecordedTools, marker);
  const payload = escapeNonAscii(
    JSON.stringify(FFF_OWNED_TOOL_GUIDANCE_SUFFIXES)
  );
  const promptHelper = serialize(
    normalizeRecordedPrompt,
    '__tweakccRecordedPrompt'
  );
  const sites: Array<Site | null> = [
    api &&
      selectSite(
        file,
        api,
        /let ([$\w]+)=([$\w]+)\(([$\w]+)\(([$\w]+)\.systemPrompt,([$\w]+)\.systemContext\)\),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)=\(\)=>\{let ([$\w]+)=([$\w]+)\(([$\w]+),\8,\{options:([$\w]+)\.options,querySource:([$\w]+),stamp:([$\w]+),toolInputCopies:\9\}\)/g,
        '__tweakccRecordedPrompt',
        promptHelper,
        FFF_OWNED_PROJECT_GUIDANCE,
        match => ({
          original: `${match[2]}(${match[3]}(${match[4]}.systemPrompt,${match[5]}.systemContext))`,
          args: [],
        })
      ),
    context &&
      selectSite(
        file,
        context,
        /let ([$\w]+)=([$\w]+)\?\.systemPrompt\?\?([$\w]+),([$\w]+)=([$\w]+)\?\.toolDescriptions,([$\w]+)=\5\?\.toolEntries/g,
        '__tweakccRecordedPrompt',
        promptHelper,
        FFF_OWNED_PROJECT_GUIDANCE,
        match => ({
          original: `${match[2]}?.systemPrompt??${match[3]}`,
          args: [],
        })
      ),
    api &&
      // CC 2.1.299+: a `restore=()=>...` declarator precedes the selection
      // and further options follow `contextRendering`.
      (selectSite(
        file,
        api,
        /let\{advisorModel:[$\w]+,advisorDeferred:[$\w]+,advisorActive:[$\w]+\}=[$\w]+,[$\w]+=\(\)=>[^,;{}]+,([$\w]+)=(([$\w]+)\(([$\w]+),([$\w]+),\{options:[$\w]+\.options,querySource:[$\w]+,resumeActive:[$\w]+,stamp:[$\w]+,[\s\S]*?contextRendering:[$\w]+\.rendering(?:,[$\w]+:[$\w]+)*\}\))/g,
        marker,
        helper,
        FFF_OWNED_TOOL_GUIDANCE_SUFFIXES,
        match => ({ original: match[2], args: [] })
      ) ??
        selectSite(
          file,
          api,
          /let\{advisorModel:[$\w]+,advisorDeferred:[$\w]+,advisorActive:[$\w]+\}=[$\w]+,([$\w]+)=(([$\w]+)\(([$\w]+),([$\w]+),\{options:[$\w]+\.options,querySource:[$\w]+,resumeActive:[$\w]+,stamp:[$\w]+,[\s\S]*?contextRendering:[$\w]+\.rendering\}\))/g,
          marker,
          helper,
          FFF_OWNED_TOOL_GUIDANCE_SUFFIXES,
          match => ({ original: match[2], args: [] })
        )),
  ];
  const contexts: Site[] = [];
  if (context) {
    for (const assignment of context.assignments) {
      if (
        !isNode(assignment.left) ||
        assignment.left.type !== 'Identifier' ||
        !isNode(assignment.right)
      ) {
        continue;
      }
      const expression = assignment.right;
      let original = expression;
      const marked =
        expression.type === 'CallExpression' &&
        isNode(expression.callee) &&
        isNode(expression.callee.id) &&
        expression.callee.id.name === marker;
      if (marked) {
        if (
          !Array.isArray(expression.arguments) ||
          !isNode(expression.arguments[0])
        ) {
          continue;
        }
        original = expression.arguments[0];
      }
      const native = file.slice(original.start, original.end);
      const canonical =
        file.slice(context.start, expression.start) +
        native +
        file.slice(expression.end, context.end);
      const pattern =
        /([$\w]+)=([$\w]+)\(([$\w]+),([$\w]+)\.options\),([$\w]+)=(([$\w]+)\(\3,\4\.options\))/g;
      for (const match of canonical.matchAll(pattern)) {
        if (
          match[5] !== assignment.left.name ||
          match[6] !== native ||
          context.start + match.index! + match[0].lastIndexOf(native) !==
            expression.start
        ) {
          continue;
        }
        const replacement = `(${helper})(${native},${payload})`;
        if (
          marked &&
          file.slice(expression.start, expression.end) !== replacement
        ) {
          continue;
        }
        contexts.push({
          start: expression.start,
          end: expression.end,
          replacement,
        });
      }
    }
  }
  sites.push(contexts.length === 1 ? contexts[0] : null);
  if (sites.some(site => site === null)) {
    console.error(
      'patch: fffInstructionHygiene: failed to find unique scoped recorded tool boundaries'
    );
    return null;
  }
  let updated = file;
  for (const site of (sites as Site[]).sort((a, b) => b.start - a.start)) {
    if (file.slice(site.start, site.end) === site.replacement) continue;
    const next =
      updated.slice(0, site.start) + site.replacement + updated.slice(site.end);
    showDiff(updated, next, site.replacement, site.start, site.end);
    updated = next;
  }
  return updated;
};
