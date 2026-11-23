import { parseRegExpLiteral, type AST } from '@eslint-community/regexpp';

type Ranges = [number, number][];

interface CharSet {
  ascii: Uint8Array;
  wide: Ranges;
}

interface Anchor {
  literal: string;
  prefix: CharSet;
}

interface Plan {
  sticky: RegExp;
  global: boolean;
  anchors: Anchor[];
}

const SAMPLE_LENGTH = 4 << 20;
const BUDGET_PER_CHAR = 4;

const DIGIT: Ranges = [[0x30, 0x39]];
const WORD: Ranges = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const SPACE: Ranges = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

export const literalAnchoredStats = { budgetFallbacks: 0 };

const escapeSetRanges = (node: AST.CharacterSet): Ranges | null => {
  if (node.kind === 'any' || node.kind === 'property' || node.negate) {
    return null;
  }
  return node.kind === 'digit' ? DIGIT : node.kind === 'word' ? WORD : SPACE;
};

const classRanges = (node: AST.CharacterClass): Ranges | null => {
  if (node.negate || node.unicodeSets) return null;
  const out: Ranges = [];
  for (const el of node.elements) {
    if (el.type === 'Character') out.push([el.value, el.value]);
    else if (el.type === 'CharacterClassRange') {
      out.push([el.min.value, el.max.value]);
    } else if (el.type === 'CharacterSet') {
      const r = escapeSetRanges(el);
      if (!r) return null;
      out.push(...r);
    } else return null;
  }
  return out;
};

const consumable = (node: AST.Element): Ranges | null => {
  switch (node.type) {
    case 'Character':
      return [[node.value, node.value]];
    case 'CharacterClass':
      return classRanges(node);
    case 'CharacterSet':
      return escapeSetRanges(node);
    case 'Quantifier':
      return consumable(node.element);
    case 'Group':
    case 'CapturingGroup': {
      if (node.type === 'Group' && node.modifiers) return null;
      const out: Ranges = [];
      for (const alt of node.alternatives) {
        for (const el of alt.elements) {
          const r = consumable(el);
          if (!r) return null;
          out.push(...r);
        }
      }
      return out;
    }
    default:
      return null;
  }
};

type Step = { char: number } | { ranges: Ranges | null };

function* flatten(elements: AST.Element[]): Generator<Step> {
  for (const el of elements) {
    if (el.type === 'Character') {
      yield { char: el.value };
    } else if (
      (el.type === 'Group' || el.type === 'CapturingGroup') &&
      el.alternatives.length === 1 &&
      !(el.type === 'Group' && el.modifiers)
    ) {
      yield* flatten(el.alternatives[0].elements);
    } else if (
      el.type === 'Quantifier' &&
      el.min >= 1 &&
      (el.element.type === 'Character' ||
        ((el.element.type === 'Group' ||
          el.element.type === 'CapturingGroup') &&
          el.element.alternatives.length === 1))
    ) {
      yield* flatten([el.element]);
      yield { ranges: consumable(el.element) };
    } else {
      yield { ranges: consumable(el) };
    }
  }
}

const toCharSet = (ranges: Ranges): CharSet => {
  const ascii = new Uint8Array(128);
  const wide: Ranges = [];
  for (const [lo, hi] of ranges) {
    for (let c = lo; c <= Math.min(hi, 127); c++) ascii[c] = 1;
    if (hi > 127) wide.push([Math.max(lo, 128), hi]);
  }
  return { ascii, wide };
};

const has = (set: CharSet, c: number): boolean => {
  if (c < 128) return set.ascii[c] === 1;
  for (const [lo, hi] of set.wide) if (c >= lo && c <= hi) return true;
  return false;
};

const overlapsItself = (s: string): boolean => {
  for (let k = 1; k < s.length; k++) {
    if (s.startsWith(s.slice(k))) return true;
  }
  return false;
};

const analyze = (regex: RegExp): Plan | null => {
  if (!/^[gs]*$/.test(regex.flags)) return null;
  let pattern: AST.Pattern;
  try {
    pattern = parseRegExpLiteral(regex).pattern;
  } catch {
    return null;
  }
  if (pattern.alternatives.length !== 1) return null;

  const anchors: Anchor[] = [];
  const prefix: Ranges = [];
  let run: number[] = [];
  let runPrefix: Ranges = [];
  const closeRun = () => {
    if (run.length === 0) return;
    const literal = String.fromCharCode(...run);
    const set = toCharSet(runPrefix);
    if (run.some(c => !has(set, c)) && !overlapsItself(literal)) {
      anchors.push({ literal, prefix: set });
    }
    for (const c of run) prefix.push([c, c]);
    run = [];
  };
  for (const step of flatten(pattern.alternatives[0].elements)) {
    if ('char' in step) {
      if (run.length === 0) runPrefix = [...prefix];
      run.push(step.char);
      continue;
    }
    closeRun();
    if (!step.ranges) break;
    prefix.push(...step.ranges);
  }
  closeRun();
  if (anchors.length === 0) return null;
  return {
    sticky: new RegExp(regex.source, regex.flags.replace('g', '') + 'y'),
    global: regex.global,
    anchors,
  };
};

const plans = new Map<string, Plan | null>();

const planFor = (regex: RegExp): Plan | null => {
  const key = `/${regex.source}/${regex.flags}`;
  let plan = plans.get(key);
  if (plan === undefined) {
    plan = analyze(regex);
    plans.set(key, plan);
  }
  return plan;
};

export const literalAnchorable = (regex: RegExp): boolean =>
  planFor(regex) !== null;

const countUpTo = (text: string, literal: string, cap: number): number => {
  let n = 0;
  for (let p = text.indexOf(literal); p !== -1 && n < cap; ) {
    n++;
    p = text.indexOf(literal, p + literal.length);
  }
  return n;
};

const pickAnchor = (text: string, anchors: Anchor[]): Anchor => {
  if (anchors.length === 1) return anchors[0];
  const sample =
    text.length > SAMPLE_LENGTH ? text.slice(0, SAMPLE_LENGTH) : text;
  let best = anchors[0];
  let bestCount = countUpTo(sample, best.literal, Infinity);
  for (const anchor of anchors.slice(1)) {
    const n = countUpTo(sample, anchor.literal, bestCount + 1);
    if (
      n < bestCount ||
      (n === bestCount && anchor.literal.length > best.literal.length)
    ) {
      best = anchor;
      bestCount = n;
    }
  }
  return best;
};

const search = (text: string, plan: Plan): RegExpExecArray[] | null => {
  const { literal, prefix } = pickAnchor(text, plan.anchors);
  const { sticky } = plan;
  const budget = BUDGET_PER_CHAR * text.length;
  const found: RegExpExecArray[] = [];
  let work = 0;
  let prevEnd = 0;
  for (
    let p = text.indexOf(literal);
    p !== -1;
    p = text.indexOf(literal, Math.max(p + 1, prevEnd))
  ) {
    let b = p - 1;
    while (b >= prevEnd && has(prefix, text.charCodeAt(b))) b--;
    work += p - 1 - b;
    let hit: RegExpExecArray | null = null;
    for (let s = b + 1; s <= p; s++) {
      work += p + literal.length - s;
      if (work > budget) {
        literalAnchoredStats.budgetFallbacks++;
        return null;
      }
      sticky.lastIndex = s;
      hit = sticky.exec(text);
      if (hit) break;
    }
    if (!hit) continue;
    found.push(hit);
    if (!plan.global) break;
    prevEnd = hit.index + hit[0].length;
  }
  return found;
};

export const literalAnchored = {
  replace(text: string, regex: RegExp, replacement: string): string {
    const plan =
      typeof replacement === 'string' && !replacement.includes('$')
        ? planFor(regex)
        : null;
    const found = plan && search(text, plan);
    if (!found) return text.replace(regex, replacement);
    if (regex.global) regex.lastIndex = 0;
    if (found.length === 0) return text;
    const parts: string[] = [];
    let at = 0;
    for (const m of found) {
      parts.push(text.slice(at, m.index), replacement);
      at = m.index + m[0].length;
    }
    parts.push(text.slice(at));
    return parts.join('');
  },

  matchAll(text: string, regex: RegExp): IterableIterator<RegExpExecArray> {
    const plan = regex.global && regex.lastIndex === 0 ? planFor(regex) : null;
    const found = plan && search(text, plan);
    if (!found) return text.matchAll(regex);
    return found[Symbol.iterator]();
  },

  match(text: string, regex: RegExp): RegExpMatchArray | null {
    const plan = regex.global ? null : planFor(regex);
    const found = plan && search(text, plan);
    if (!found) return text.match(regex);
    return found[0] ?? null;
  },
};
