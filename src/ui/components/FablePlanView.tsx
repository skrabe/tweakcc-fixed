import React, { useContext, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { SettingsContext } from '../App';
import { FablePlanConfig } from '../../types';
import { DEFAULT_SETTINGS } from '../../defaultSettings';

const MODELS: FablePlanConfig['planModel'][] = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
];

const label = (alias: string): string =>
  alias.charAt(0).toUpperCase() + alias.slice(1);

type Row =
  | { kind: 'enabled' }
  | { kind: 'model'; side: 'plan' | 'exec' }
  | { kind: 'clearContext' };

const ROWS: Row[] = [
  { kind: 'enabled' },
  { kind: 'model', side: 'plan' },
  { kind: 'model', side: 'exec' },
  { kind: 'clearContext' },
];

export const FablePlanView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { settings, updateSettings } = useContext(SettingsContext);
  // Always read through a fully-defaulted copy, so a config written before this
  // block existed still renders sane values.
  const fablePlan: FablePlanConfig = {
    ...DEFAULT_SETTINGS.fablePlan,
    ...(settings.fablePlan ?? {}),
  };
  const [index, setIndex] = useState(0);

  const update = (patch: Partial<FablePlanConfig>): void => {
    updateSettings(s => ({
      ...s,
      fablePlan: {
        ...DEFAULT_SETTINGS.fablePlan,
        ...(s.fablePlan ?? {}),
        ...patch,
      },
    }));
  };

  // Left/right cycles the focused row's value. The models are a small closed
  // set, so a picker sub-view would be more chrome than the choice deserves.
  const cycle = (delta: number): void => {
    const row = ROWS[index];
    if (row.kind === 'enabled') {
      update({ enabled: !fablePlan.enabled });
      return;
    }
    if (row.kind === 'clearContext') {
      update({
        offerClearContextOnPlanAccept: !fablePlan.offerClearContextOnPlanAccept,
      });
      return;
    }
    const key = row.side === 'plan' ? 'planModel' : 'execModel';
    const other =
      row.side === 'plan' ? fablePlan.execModel : fablePlan.planModel;
    const from = MODELS.indexOf(fablePlan[key]);
    // Skip the other side's model: pairing a model with itself is not a
    // pairing, and the patch refuses it rather than emitting a no-op alias.
    for (let step = 1; step <= MODELS.length; step++) {
      const next =
        MODELS[(from + delta * step + MODELS.length * step) % MODELS.length];
      if (next !== other) {
        update({ [key]: next } as Partial<FablePlanConfig>);
        return;
      }
    }
  };

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onBack();
      return;
    }
    if (key.upArrow) setIndex(i => (i - 1 + ROWS.length) % ROWS.length);
    else if (key.downArrow) setIndex(i => (i + 1) % ROWS.length);
    else if (key.leftArrow) cycle(-1);
    else if (key.rightArrow || key.return || input === ' ') cycle(1);
    else if (input === 'x') update({ ...DEFAULT_SETTINGS.fablePlan });
  });

  const row = (i: number, name: string, value: string): React.ReactElement => (
    <Box key={name}>
      <Text color={i === index ? 'cyan' : undefined}>
        {i === index ? '❯ ' : '  '}
        {name.padEnd(26)}
      </Text>
      <Text color={i === index ? 'cyan' : 'green'} bold={i === index}>
        {value}
      </Text>
    </Box>
  );

  const alias = `${fablePlan.planModel}plan`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Fable Plan mode</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Adds a <Text color="green">{alias}</Text> entry to Claude Code&apos;s{' '}
          <Text color="green">/model</Text> list: {label(fablePlan.planModel)}{' '}
          while planning, {label(fablePlan.execModel)} while executing, each at
          the effort you set for that model in <Text color="green">/model</Text>
          .
        </Text>
        <Text dimColor>
          It is a model you select, the same mechanism Claude Code ships for
          opusplan. Nothing changes for any other model, and your selection
          stays <Text color="green">{alias}</Text> throughout — the pairing is
          resolved per request, so no model is ever switched underneath you
          mid-session.
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {ROWS.map((r, i) => {
          if (r.kind === 'enabled') {
            return row(i, 'Enabled', fablePlan.enabled ? 'yes' : 'no');
          }
          if (r.kind === 'clearContext') {
            return row(
              i,
              'Offer "clear context"',
              fablePlan.offerClearContextOnPlanAccept ? 'yes' : 'no'
            );
          }
          const side = r.side === 'plan' ? 'Planning' : 'Executing';
          return row(
            i,
            `${side} model`,
            label(r.side === 'plan' ? fablePlan.planModel : fablePlan.execModel)
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Claude Code defaults its &quot;clear context&quot; option off. On, the
          plan-approval dialog offers &quot;Yes, clear context (N% used)&quot;,
          which hands only the plan to {label(fablePlan.execModel)}. Continuing
          instead re-sends the whole planning transcript to a different model,
          so the cache is cold either way and you pay for the transcript twice.
        </Text>
        <Text dimColor>
          Reasoning effort is Claude Code&apos;s own per-model setting: pick{' '}
          {label(fablePlan.planModel)} in <Text color="green">/model</Text>, set
          its effort, then do the same for {label(fablePlan.execModel)}. An
          explicit <Text color="green">/effort</Text> applies to both sides for
          the rest of the session.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ move · ←→ change · x reset to defaults · esc back
        </Text>
      </Box>
    </Box>
  );
};
