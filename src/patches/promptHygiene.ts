export function normalizeRecordedPrompt(
  prompt: unknown,
  owned: unknown
): unknown {
  if (
    !Array.isArray(prompt) ||
    !prompt.every(part => typeof part === 'string') ||
    !Array.isArray(owned)
  ) {
    return prompt;
  }
  const updated = prompt
    .filter(
      part => !owned.includes(part) && part !== '# Environment\n - \n - \n - '
    )
    .map(part =>
      part.replace(
        /(^|\n\n)# Environment\n - \n - \n - \n\n(?=# Context management\n)/g,
        '$1'
      )
    );
  return updated.length === prompt.length &&
    updated.every((part, i) => part === prompt[i])
    ? prompt
    : updated;
}
