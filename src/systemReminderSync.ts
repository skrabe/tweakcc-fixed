import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import { SYSTEM_REMINDERS_DIR } from './config';

export interface ReminderOverride {
  id: string;
  name: string;
  description: string;
  ccVersion: string;
  placeholders: string[];
  body: string;
  isSuppressed: boolean;
}

export const parseReminderMarkdown = (
  id: string,
  markdown: string
): ReminderOverride => {
  const parsed = matter(markdown, { delimiters: ['<!--', '-->'] });
  const data = parsed.data as Record<string, unknown>;
  const body = (parsed.content ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
  return {
    id,
    name: typeof data.name === 'string' ? data.name : id,
    description: typeof data.description === 'string' ? data.description : '',
    ccVersion: typeof data.ccVersion === 'string' ? data.ccVersion : '',
    placeholders: Array.isArray(data.placeholders)
      ? (data.placeholders as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : [],
    body,
    isSuppressed: body.trim().length === 0,
  };
};

export const serializeReminderMarkdown = (
  name: string,
  description: string,
  ccVersion: string,
  placeholders: string[],
  body: string
): string => {
  const frontmatter: Record<string, unknown> = {
    name,
    description,
    ccVersion,
  };
  if (placeholders.length > 0) frontmatter.placeholders = placeholders;
  return matter.stringify(body, frontmatter, {
    delimiters: ['<!--', '-->'],
  });
};

export const loadReminderOverride = async (
  id: string
): Promise<ReminderOverride | null> => {
  const filePath = path.join(SYSTEM_REMINDERS_DIR, `${id}.md`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseReminderMarkdown(id, raw);
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
};

export const ensureReminderOverrideFile = async (
  id: string,
  name: string,
  description: string,
  ccVersion: string,
  placeholders: string[],
  defaultBody: string
): Promise<boolean> => {
  const filePath = path.join(SYSTEM_REMINDERS_DIR, `${id}.md`);
  try {
    await fs.stat(filePath);
    return false;
  } catch (err) {
    if (
      !(
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      )
    ) {
      throw err;
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    serializeReminderMarkdown(
      name,
      description,
      ccVersion,
      placeholders,
      defaultBody
    )
  );
  return true;
};

export const substitutePlaceholders = (
  body: string,
  whitelistMap: Record<string, string>
): { result: string; errors: string[] } => {
  const errors: string[] = [];
  const allowedNames = new Set(Object.keys(whitelistMap));

  const tokenRe = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let match;
  while ((match = tokenRe.exec(body)) !== null) {
    if (!allowedNames.has(match[1])) {
      errors.push(
        `unknown placeholder "{{${match[1]}}}"; allowed: ${[...allowedNames].map(n => `{{${n}}}`).join(', ') || '(none)'}`
      );
    }
  }
  if (errors.length > 0) {
    return { result: '', errors };
  }

  // Split-escape-rejoin so user text is JS-template-literal-safe while
  // placeholder expressions are passed through unescaped.
  const segments = body.split(tokenRe);
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 0) {
      out += segments[i]
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
    } else {
      out += whitelistMap[segments[i]];
    }
  }

  return { result: out, errors: [] };
};
