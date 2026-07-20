// Normalized projection of a captured /v1/messages body, plus canary
// evaluation over it.
//
// The projection is deliberately narrow — system[].text, tools[].name and
// tools[].description. A raw full-request snapshot churns on every version and
// gets mechanically re-blessed, which is worse than having no test at all.

export class LivenessError extends Error {}

const textOf = block => {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object' && typeof block.text === 'string') {
    return block.text;
  }
  return '';
};

export const buildProjection = body => {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  if (!parsed || typeof parsed !== 'object') {
    throw new LivenessError('captured body is not a JSON object');
  }
  const rawSystem = parsed.system;
  const system = Array.isArray(rawSystem)
    ? rawSystem.map(textOf)
    : [textOf(rawSystem)].filter(Boolean);
  const tools = (Array.isArray(parsed.tools) ? parsed.tools : []).map(t => ({
    name: typeof t?.name === 'string' ? t.name : '',
    description: typeof t?.description === 'string' ? t.description : '',
  }));
  return { model: parsed.model ?? null, system, tools };
};

// A request only counts as the main agent turn if it carries tools AND the
// marker sits in the message history. Claude Code also fires a Haiku
// title-generation side-call that contains the marker but no tools; taking the
// first marker match would capture that instead and assert against a projection
// that has nothing to do with the maintained prompt set.
export const isMainTurn = (body, marker) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed?.tools) || parsed.tools.length === 0) return false;
  if (!Array.isArray(parsed?.messages)) return false;
  return JSON.stringify(parsed.messages).includes(marker);
};

const scopeText = (projection, where) => {
  if (where === 'system') return projection.system.join('\n');
  if (where === 'tools') {
    return projection.tools.map(t => t.description).join('\n');
  }
  if (where === 'all') {
    return [
      ...projection.system,
      ...projection.tools.map(t => `${t.name}\n${t.description}`),
    ].join('\n');
  }
  if (where && typeof where === 'object' && where.tool) {
    const tool = projection.tools.find(t => t.name === where.tool);
    if (!tool) return null;
    return tool.description;
  }
  throw new LivenessError(`unknown canary scope: ${JSON.stringify(where)}`);
};

const describeScope = where =>
  typeof where === 'string' ? where : `tool:${where.tool}`;

export const evaluateCanaries = (row, projection) =>
  row.canaries.map(canary => {
    const scope = describeScope(canary.where);
    const haystack = scopeText(projection, canary.where);
    const fail = detail => ({
      id: canary.id,
      row: row.id,
      scope,
      pass: false,
      detail,
      why: canary.why,
    });
    if (haystack === null) {
      return fail(`scope ${scope} is absent from the captured request`);
    }
    if (canary.mustContain !== undefined) {
      if (!haystack.includes(canary.mustContain)) {
        return fail(`missing ${JSON.stringify(canary.mustContain)}`);
      }
    }
    if (canary.mustNotContain !== undefined) {
      if (haystack.includes(canary.mustNotContain)) {
        return fail(
          `unexpectedly present ${JSON.stringify(canary.mustNotContain)}`
        );
      }
    }
    if (canary.mustNotMatch !== undefined) {
      const found = haystack.match(new RegExp(canary.mustNotMatch));
      if (found) {
        return fail(`matched forbidden pattern at ${JSON.stringify(found[0])}`);
      }
    }
    return {
      id: canary.id,
      row: row.id,
      scope,
      pass: true,
      detail: null,
      why: canary.why,
    };
  });

export const renderProjection = (row, projection) => {
  const lines = [
    `# liveness projection — row ${row.id}`,
    `# ${row.summary}`,
    `# model: ${projection.model}`,
    `# selectors: ${JSON.stringify(row.selectors)}`,
    '',
    `## system (${projection.system.length} blocks)`,
  ];
  projection.system.forEach((text, i) => {
    lines.push('', `### system[${i}] (${text.length} chars)`, text);
  });
  lines.push('', `## tools (${projection.tools.length})`);
  for (const tool of projection.tools) {
    lines.push(
      '',
      `### ${tool.name} (${tool.description.length} chars)`,
      tool.description
    );
  }
  return lines.join('\n') + '\n';
};
