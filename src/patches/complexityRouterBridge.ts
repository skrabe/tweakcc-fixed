const MODULE_MARK = '/*@@TWEAKCC_MODULE:';

export const isSplitRouterBundle = (file: string): boolean =>
  file.includes(MODULE_MARK);

export function bindRouterModules(
  file: string,
  helpers: { gB: string; km: string; gBIndex?: number; kmIndex?: number }
): { file: string; helpers: { gB: string; km: string } } | null {
  if (!isSplitRouterBundle(file)) return { file, helpers };
  const insertions: { at: number; text: string }[] = [];
  const bind = (name: string, at: number | undefined, key: string) => {
    if (at === undefined) return null;
    const start = file.lastIndexOf(MODULE_MARK, at);
    const end = file.indexOf('@@*/', start);
    if (start < 0 || end < 0) return null;
    const identity = file.slice(start + MODULE_MARK.length, end);
    const separator = identity.indexOf(':');
    if (separator < 0) return null;
    insertions.push({ at, text: `globalThis.${key}=${name};` });
    return `globalThis.${key}`;
  };
  const gB = bind(helpers.gB, helpers.gBIndex, '__tweakccRouterHaiku');
  const km = bind(helpers.km, helpers.kmIndex, '__tweakccRouterAgentContext');
  if (!gB || !km) return null;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) {
    file =
      file.slice(0, insertion.at) + insertion.text + file.slice(insertion.at);
  }
  return { file, helpers: { gB, km } };
}
