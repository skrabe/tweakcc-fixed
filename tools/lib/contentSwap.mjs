// Content-swap sweep: an id whose CONTENT moved while the id stayed put.
//
// Collision suffixes (`-2`, `-3`) are positional. When CC inserts a new prompt
// ahead of a family, every later member shifts one suffix up: on CC 2.1.291 a
// new body landed at system-prompt-resume-continue-prompt-2, so the old -2 body
// became -3 and the old -3 body became -4. An override keyed by id then sits on
// a different prompt's content, and a realign of that id overwrites a curated
// trim with the new occupant's pristine.
//
// Bodies are the string PIECES joined, never reconstructed with identifierMap
// labels inlined: a bump that adopts new slot labels would otherwise turn every
// relabelled prompt into a phantom swap (CC 2.1.251).

export const piecesBody = entry =>
  Array.isArray(entry.pieces) && entry.pieces.length
    ? entry.pieces.filter(x => typeof x === 'string').join('')
    : entry.content || '';

export const indexBodies = prompts => {
  const bodies = new Map();
  const versions = new Map();
  for (const e of prompts) {
    if (!e.id) continue;
    if (!bodies.has(e.id)) bodies.set(e.id, new Set());
    if (!versions.has(e.id)) versions.set(e.id, new Set());
    bodies.get(e.id).add(piecesBody(e));
    versions.get(e.id).add(String(e.version ?? null));
  }
  return { bodies, versions };
};

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// swaps: one row per (id, body) where the id's current body was ANOTHER id's
//   previous body and not its own. `moved` is true when that other id no longer
//   carries the body (its content left it), false when both ids carry it now.
// movedFrom: previous owner -> ids its body now sits at (moved rows only).
// versionStale: ids whose body set changed while their version set did not.
export const contentSwapSweep = (prevPrompts, curPrompts) => {
  const prev = indexBodies(prevPrompts);
  const cur = indexBodies(curPrompts);
  const owners = new Map();
  for (const [id, set] of prev.bodies) {
    for (const b of set) {
      if (!b.trim()) continue;
      if (!owners.has(b)) owners.set(b, new Set());
      owners.get(b).add(id);
    }
  }
  const swaps = [];
  const movedFrom = new Map();
  for (const [id, set] of cur.bodies) {
    for (const b of set) {
      if (!b.trim() || prev.bodies.get(id)?.has(b)) continue;
      const from = [...(owners.get(b) || [])].filter(o => o !== id).sort();
      if (!from.length) continue;
      const moved = from.every(o => !cur.bodies.get(o)?.has(b));
      swaps.push({ id, from, moved, newId: !prev.bodies.has(id), chars: b.length });
      if (moved) {
        for (const o of from) {
          if (!movedFrom.has(o)) movedFrom.set(o, new Set());
          movedFrom.get(o).add(id);
        }
      }
    }
  }
  const versionStale = [];
  for (const [id, set] of cur.bodies) {
    const p = prev.bodies.get(id);
    if (!p || sameSet(p, set)) continue;
    if (sameSet(prev.versions.get(id), cur.versions.get(id))) {
      versionStale.push({ id, versions: [...cur.versions.get(id)].sort() });
    }
  }
  swaps.sort((a, b) => a.id.localeCompare(b.id));
  versionStale.sort((a, b) => a.id.localeCompare(b.id));
  return { swaps, movedFrom, versionStale };
};

// Why a realign task on `id` is unsafe, or null. Two shapes, both from the
// 2.1.291 incident: the override's OLD pristine now lives at another id (its
// trim belongs there), or the id now holds another id's previous content (a
// realign would graft the new occupant's pristine over a trim of something
// else).
export const realignHazard = (sweep, id) => {
  const reasons = [];
  const to = sweep.movedFrom.get(id);
  if (to && to.size) {
    reasons.push(
      `its previous pristine moved to ${[...to].sort().join(', ')}`
    );
  }
  const got = sweep.swaps.filter(s => s.id === id);
  for (const s of got) {
    reasons.push(
      `its current pristine is ${s.from.join(', ')}'s previous body${s.moved ? '' : ' (still carried there too)'}`
    );
  }
  return reasons.length ? reasons.join('; ') : null;
};
