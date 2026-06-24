import { describe, it, expect } from 'vitest';
import { writeSubagentModels } from './subagentModels';
import type { SubagentModelsConfig } from '../types';

// Fixture mirrors the three minified agent shapes the patch targets:
//   {agentType:"Plan",...,model:"..."} / "Explore" / "general-purpose".
const FIXTURE =
  'a=1;P={agentType:"Plan",description:"d",model:"claude-sonnet-4-20250514"};' +
  'E={agentType:"Explore",description:"d",model:"claude-sonnet-4-20250514"};' +
  'G={agentType:"general-purpose",description:"d",model:"claude-old"};b=2;';

const cfg = (c: Partial<SubagentModelsConfig>) => c as SubagentModelsConfig;

describe('writeSubagentModels', () => {
  it('sets each agent model as a JSON string literal', () => {
    const out = writeSubagentModels(
      FIXTURE,
      cfg({ plan: 'my-model', explore: 'x-model', generalPurpose: 'g-model' })
    );
    expect(out).toContain('agentType:"Plan",description:"d",model:"my-model"');
    expect(out).toContain(
      'agentType:"Explore",description:"d",model:"x-model"'
    );
    expect(out).toContain(
      'agentType:"general-purpose",description:"d",model:"g-model"'
    );
  });

  it('adds a model field to general-purpose when absent', () => {
    const noModel = 'a=1;G={agentType:"general-purpose",description:"d"};';
    const out = writeSubagentModels(
      noModel,
      cfg({ generalPurpose: 'g-model' })
    );
    expect(out).toContain('model:"g-model"');
  });

  // Regression guard for F-89: config models are reachable via untrusted
  // --config-url, so a quote/backslash/$ must not break out of the model:"..."
  // literal or trigger String.replace $-substitution.
  it('JSON-escapes a malicious model value at every site (F-89)', () => {
    const evil = 'ev"il\\back$1$&m';
    const out = writeSubagentModels(
      FIXTURE,
      cfg({ plan: evil, explore: evil, generalPurpose: evil })
    )!;
    // The escaped literal is present; the raw breakout form is not.
    expect(out).toContain('model:' + JSON.stringify(evil));
    expect(out).not.toContain(`model:"${evil}"`);
    // Every emitted model literal is a valid JS string (no broken quotes).
    const literals = out.match(/model:("(?:[^"\\]|\\.)*")/g) ?? [];
    expect(literals).toHaveLength(3);
    for (const lit of literals) {
      expect(() => JSON.parse(lit.slice('model:'.length))).not.toThrow();
    }
  });

  it('returns the file unchanged when no agent is configured', () => {
    expect(writeSubagentModels(FIXTURE, cfg({}))).toBe(FIXTURE);
  });

  it('returns null when a configured agent shape is absent', () => {
    // plan configured but the Plan shape isn't present -> patchPlanAgent null.
    expect(writeSubagentModels('nothing here', cfg({ plan: 'm' }))).toBeNull();
  });
});
