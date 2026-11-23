export type PatchStep = (file: string) => string | null;

export const runPatchSteps = (
  file: string,
  steps: readonly PatchStep[]
): string | null => {
  let current = file;
  for (const step of steps) {
    const next = step(current);
    if (next === null) return null;
    current = next;
  }
  return current;
};
