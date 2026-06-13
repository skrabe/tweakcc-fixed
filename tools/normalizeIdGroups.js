// Pure utility extracted from promptExtractor.js — no third-party dependencies.
// Keeping this in its own file lets the vitest test import it without pulling in
// @babel/parser or any other tool-specific dep that lives only in tools/node_modules.

/**
 * @param {{ id?: string, version?: string, start: number, end: number }[]} prompts
 * @returns {typeof prompts}
 */
export function normalizeIdGroups(prompts) {
  const byId = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }

  const semverNewer = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0;
    }
    return false;
  };

  const dropped = new Set();
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const inner of group) {
      const outer = group.find(
        o =>
          o !== inner &&
          !dropped.has(o) &&
          inner.start >= o.start &&
          inner.end <= o.end
      );
      if (outer) {
        dropped.add(inner);
        console.log(
          `Dropped nested same-id duplicate of "${id}" (${inner.start}-${inner.end} inside ${outer.start}-${outer.end})`
        );
      }
    }
    const kept = group.filter(p => !dropped.has(p));
    const maxVersion = kept.reduce(
      (v, p) =>
        p.version && (!v || semverNewer(p.version, v)) ? p.version : v,
      ''
    );
    if (!maxVersion) continue;
    for (const p of kept) {
      if (p.version !== maxVersion) {
        console.log(
          `Normalized "${id}" entry version ${p.version} → ${maxVersion} (id-group max)`
        );
        p.version = maxVersion;
      }
    }
  }

  return prompts.filter(p => !dropped.has(p));
}
