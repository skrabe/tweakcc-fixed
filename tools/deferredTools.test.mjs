import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveCaptureDir,
  capturedTools,
  makeToolStatus,
  captureLine,
} from './lib/deferredTools.mjs';

const capture = {
  file: '/x/req-004.json',
  names: ['Bash', 'Read', 'AskUserQuestion'],
  text: 'Executes a bash command and returns its output.\nReads a file from the local filesystem and returns it.',
};
const names = {
  'tool-description-webfetch-fixture': 'Tool Description: WebFetch (fixture)',
  'tool-parameter-fixture-ask': 'Tool Parameter: AskUserQuestion header',
};
const texts = {
  'tool-description-read-fixture-note': ['Reads a file from the local filesystem and returns it.'],
  'tool-description-read-fixture-mcp-resource': ['Reads a resource from an MCP server by its URI.'],
};
const status = makeToolStatus(capture, id => names[id] || '', id => texts[id] || []);

describe('makeToolStatus', () => {
  it('marks a tool absent from the capture tools[] as deferred', () => {
    expect(status('tool-description-webfetch-fixture')).toBe('deferred');
    expect(status('tool-parameter-proposegoal-fixture')).toBe('deferred');
  });
  it('marks an offered tool always-on by its full id or CamelCase name', () => {
    expect(status('tool-description-bash')).toBe('always-on');
    expect(status('tool-parameter-ask-user-question-fixture')).toBe('always-on');
    expect(status('tool-parameter-fixture-ask')).toBe('always-on');
  });
  it('needs text evidence when only a first-token prefix names an offered tool', () => {
    expect(status('tool-description-read-fixture-note')).toBe('always-on');
    expect(status('tool-description-read-fixture-mcp-resource')).toBe('unresolved');
  });
  it('ignores ids that are not tool descriptions or parameters', () => {
    expect(status('tool-result-webfetch-fixture')).toBeNull();
    expect(status('system-prompt-fixture')).toBeNull();
  });
  it('marks nothing without a capture', () => {
    expect(makeToolStatus(null)('tool-description-webfetch-fixture')).toBeNull();
    expect(captureLine(null, null)).toMatch(/No turnProbe capture/);
  });
});

describe('capture resolution', () => {
  it('reads tools[] from the largest request body and finds the recorded dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-tools-'));
    const dir = path.join(tmp, 'turnprobe-9.9.9-1');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'req-001.json'), JSON.stringify({ model: 'm', messages: [] }));
    fs.writeFileSync(
      path.join(dir, 'req-002.json'),
      JSON.stringify({ tools: [{ name: 'Bash', description: 'Runs it.', input_schema: { properties: { command: { description: 'The command' } } } }], messages: [{ content: 'x'.repeat(50) }] })
    );
    expect(resolveCaptureDir('9.9.9', { env: {}, tmp })).toBe(dir);
    const c = capturedTools(dir);
    expect(c.names).toEqual(['Bash']);
    expect(c.text).toContain('The command');
    expect(captureLine(dir, c)).toMatch(/Always-on tools .*: Bash\./);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
