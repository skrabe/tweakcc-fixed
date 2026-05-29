// Please see the note about writing patches in ./index
//
// This patch swaps the model CC's auto-mode bash safety classifier uses.
//
// CC 2.1.138 ships:
//
//     function OV7(){let H=M_("tengu_auto_mode_config",{});if(H?.model)return H.model;return IK()}
//
// OV7 resolves the classifier model: first consults Anthropic's server-side
// `tengu_auto_mode_config` Statsig dynamic config; if that doesn't carry a
// `model` field, falls back to IK() — the user's current main-loop model.
//
// Users on Opus 4.7 [1m] end up using Opus 4.7 [1m] for the classifier too.
// When Opus 4.7 is congested the classifier itself goes "temporarily
// unavailable" and (with the default fail-closed gate) every non-allowlisted
// bash command in auto mode gets denied. Routing the classifier through a
// cheaper, higher-capacity model fixes the user-visible failure mode.
//
// The classifier task is a binary XML response over a short transcript
// excerpt — well within Haiku 4.5 or Sonnet 4.6 capability. Both model IDs
// are already known to the binary (no extra registration needed).

import { debug } from '../utils';
import { showDiff } from './index';

export type AutoModeClassifierModel = 'default' | 'sonnet' | 'haiku';

const MODEL_IDS: Record<Exclude<AutoModeClassifierModel, 'default'>, string> = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

export const writeAutoModeClassifierModel = (
  oldFile: string,
  choice: AutoModeClassifierModel
): string | null => {
  if (choice === 'default') return oldFile;

  const modelId = MODEL_IDS[choice];

  // function NAME(){let VAR=READER("tengu_auto_mode_config",{});if(VAR?.model)return VAR.model;return DEFAULT_FN()}
  const pattern =
    /function\s+([$\w]+)\s*\(\s*\)\s*\{\s*let\s+([$\w]+)\s*=\s*([$\w]+)\s*\(\s*"tengu_auto_mode_config"\s*,\s*\{\s*\}\s*\)\s*;\s*if\s*\(\s*\2\s*\?\.\s*model\s*\)\s*return\s+\2\s*\.\s*model\s*;\s*return\s+([$\w]+)\s*\(\s*\)\s*\}/;
  // CC 2.1.156 shape: arg-less resolver that first checks Opus-4.8's
  // tengu_cedar_hollow_7m config, then tengu_auto_mode_config, then falls back
  // to the main-loop model:
  // function NAME(){let H=FN();if(MODEL(H)==="claude-opus-4-8"){let q=R("tengu_cedar_hollow_7m",{});if(q?.model)return q.model}let _=R("tengu_auto_mode_config",{});if(_?.model)return _.model;return H}
  const pattern156 =
    /function\s+([$\w]+)\s*\(\s*\)\s*\{\s*let\s+([$\w]+)\s*=\s*([$\w]+)\s*\(\s*\)\s*;\s*if\s*\(\s*([$\w]+)\s*\(\s*\2\s*\)\s*===\s*"claude-opus-4-8"\s*\)\s*\{\s*let\s+([$\w]+)\s*=\s*([$\w]+)\s*\(\s*"tengu_cedar_hollow_7m"\s*,\s*\{\s*\}\s*\)\s*;\s*if\s*\(\s*\5\s*\?\.\s*model\s*\)\s*return\s+\5\s*\.\s*model\s*\}\s*let\s+([$\w]+)\s*=\s*([$\w]+)\s*\(\s*"tengu_auto_mode_config"\s*,\s*\{\s*\}\s*\)\s*;\s*if\s*\(\s*\7\s*\?\.\s*model\s*\)\s*return\s+\7\s*\.\s*model\s*;\s*return\s+\2\s*\}/;

  const match = oldFile.match(pattern156) || oldFile.match(pattern);
  if (match && match.index !== undefined) {
    const [fullMatch, fnName] = match;
    const replacement = `function ${fnName}(){return "${modelId}"}`;
    const newFile =
      oldFile.slice(0, match.index) +
      replacement +
      oldFile.slice(match.index + fullMatch.length);
    showDiff(
      oldFile,
      newFile,
      replacement,
      match.index,
      match.index + fullMatch.length
    );
    return newFile;
  }

  // Idempotency: an already-patched resolver has the shape
  //   function NAME(){return "claude-<family>-<x>-<y>"}
  // with no `let` / no `tengu_auto_mode_config` reference inside its body.
  if (
    /function\s+[$\w]+\s*\(\s*\)\s*\{\s*return\s*"claude-(opus|sonnet|haiku)-[0-9a-z-]+"\s*\}/.test(
      oldFile
    )
  ) {
    debug(
      'patch: autoModeClassifierModel: classifier-model resolver already patched — skipping'
    );
    return oldFile;
  }

  // Feature-gone fallback: the dynamic-config key is absent.
  if (!oldFile.includes('"tengu_auto_mode_config"')) {
    debug(
      'patch: autoModeClassifierModel: tengu_auto_mode_config not present in this CC build — no-op'
    );
    return oldFile;
  }

  console.error(
    'patch: autoModeClassifierModel: failed to find auto-mode classifier resolver'
  );
  return null;
};
