import { Box, Text, useInput, useStdin } from 'ink';
import { useContext, useState } from 'react';
import { SettingsContext } from '../App';
import Header from './Header';
import { DEFAULT_SETTINGS } from '../../defaultSettings';
import { ComplexityRouterConfig, RouterEffort } from '../../types';
import { editTextInEditor } from '../../utils';

interface ComplexityRouterViewProps {
  onBack: () => void;
}

const EFFORT_OPTIONS: { value: RouterEffort; blurb: string }[] = [
  { value: 'low', blurb: 'Fastest, cheapest - minimal reasoning' },
  { value: 'medium', blurb: 'Balanced reasoning' },
  { value: 'high', blurb: 'Deep reasoning' },
  { value: 'xhigh', blurb: 'Very deep reasoning' },
  { value: 'max', blurb: 'Maximum reasoning - slowest, priciest' },
];

// Numeric (free-entry) settings: config key -> display + clamp range. The
// bounds mirror config.ts normalization so the TUI can't save an out-of-range
// value either.
type NumericRow = 'messageCap' | 'assistantCap' | 'timeoutMs';
const NUMERIC_ROWS: Record<
  NumericRow,
  { label: string; unit: string; lo: number; hi: number; hint: string }
> = {
  messageCap: {
    label: 'Message cap',
    unit: 'chars',
    lo: 500,
    hi: 400000,
    hint: 'max chars of a user message fed to the classifier',
  },
  assistantCap: {
    label: 'Assistant cap',
    unit: 'chars',
    lo: 500,
    hi: 400000,
    hint: 'prev assistant reply beyond this is middle-truncated (head+tail + an omitted-size marker the classifier weighs); no mechanical floor',
  },
  timeoutMs: {
    label: 'Haiku timeout',
    unit: 'ms',
    lo: 1000,
    hi: 120000,
    hint: 'classifier call timeout; on timeout the router fails open',
  },
};

// Settings rows that live above the per-level list.
type SettingRow = 'enabled' | 'pinPerTask' | NumericRow | 'systemPrompt';
const SETTING_ROWS: SettingRow[] = [
  'enabled',
  'pinPerTask',
  'messageCap',
  'assistantCap',
  'timeoutMs',
  'systemPrompt',
];
const isNumericRow = (row: SettingRow): row is NumericRow =>
  row in NUMERIC_ROWS;

type SubPicker = { levelIndex: number } | null;
type Editing = { row: NumericRow; value: string } | null;
// Inline text edit for a level's label/help (short free-text fields).
type TextEdit = {
  kind: 'label' | 'help';
  levelIndex: number;
  value: string;
} | null;

const defaultRouter = DEFAULT_SETTINGS.complexityRouter;

export function ComplexityRouterView({ onBack }: ComplexityRouterViewProps) {
  const { settings, updateSettings } = useContext(SettingsContext);

  // Always read through a fully-defaulted copy so an older config without the
  // complexityRouter block (or missing a field) renders sane values.
  const router: ComplexityRouterConfig = {
    ...defaultRouter,
    ...(settings.complexityRouter ?? {}),
    levels:
      settings.complexityRouter?.levels &&
      settings.complexityRouter.levels.length > 0
        ? settings.complexityRouter.levels
        : defaultRouter.levels,
  };

  // Flat navigable list: the setting rows, then one row per level.
  const totalRows = SETTING_ROWS.length + router.levels.length;
  const { setRawMode, isRawModeSupported } = useStdin();
  const [focusIndex, setFocusIndex] = useState(0);
  const [picker, setPicker] = useState<SubPicker>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [textEdit, setTextEdit] = useState<TextEdit>(null);
  // Bumped after $EDITOR returns to force a clean re-render of the suspended TUI.
  const [, setRefresh] = useState(0);

  const mutate = (fn: (r: ComplexityRouterConfig) => void) => {
    updateSettings(s => {
      const current: ComplexityRouterConfig = {
        ...defaultRouter,
        ...(s.complexityRouter ?? {}),
        // deep-copy levels so we never mutate the default array in place
        levels: (s.complexityRouter?.levels &&
        s.complexityRouter.levels.length > 0
          ? s.complexityRouter.levels
          : defaultRouter.levels
        ).map(l => ({ ...l })),
      };
      fn(current);
      s.complexityRouter = current;
    });
  };

  useInput((input, key) => {
    // ---- inline text edit mode (level label/help) ----
    if (textEdit) {
      if (key.escape) {
        setTextEdit(null);
        return;
      }
      if (key.return) {
        const { kind, levelIndex: li, value } = textEdit;
        mutate(r => {
          const lv = r.levels[li];
          if (lv) lv[kind] = value;
        });
        setTextEdit(null);
        return;
      }
      if (key.backspace || key.delete) {
        setTextEdit(e => (e ? { ...e, value: e.value.slice(0, -1) } : e));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setTextEdit(e => (e ? { ...e, value: e.value + input } : e));
      }
      return;
    }

    // ---- numeric edit mode ----
    if (editing) {
      if (key.escape) {
        setEditing(null);
        return;
      }
      if (key.return) {
        const meta = NUMERIC_ROWS[editing.row];
        const parsed = parseInt(editing.value, 10);
        const n = Number.isFinite(parsed)
          ? Math.min(meta.hi, Math.max(meta.lo, parsed))
          : defaultRouter[editing.row];
        const row = editing.row;
        mutate(r => {
          r[row] = n;
        });
        setEditing(null);
        return;
      }
      if (key.backspace || key.delete) {
        setEditing(e => (e ? { ...e, value: e.value.slice(0, -1) } : e));
        return;
      }
      if (/^[0-9]$/.test(input)) {
        setEditing(e =>
          e && e.value.length < 7 ? { ...e, value: e.value + input } : e
        );
      }
      return;
    }

    // ---- effort sub-picker mode ----
    if (picker) {
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.upArrow) {
        setPickerIndex(p => (p > 0 ? p - 1 : EFFORT_OPTIONS.length - 1));
        return;
      }
      if (key.downArrow) {
        setPickerIndex(p => (p < EFFORT_OPTIONS.length - 1 ? p + 1 : 0));
        return;
      }
      if (key.return) {
        const value = EFFORT_OPTIONS[pickerIndex].value;
        const levelIndex = picker.levelIndex;
        mutate(r => {
          if (r.levels[levelIndex]) r.levels[levelIndex].effort = value;
        });
        setPicker(null);
      }
      return;
    }

    // ---- main list mode ----
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setFocusIndex(i => (i > 0 ? i - 1 : totalRows - 1));
      return;
    }
    if (key.downArrow) {
      setFocusIndex(i => (i < totalRows - 1 ? i + 1 : 0));
      return;
    }

    const isSettingRow = focusIndex < SETTING_ROWS.length;
    const levelIndex = focusIndex - SETTING_ROWS.length;

    // 'x' resets a focused setting/prompt OR a level (label+help+effort) to default.
    if (input === 'x') {
      if (isSettingRow) {
        const row = SETTING_ROWS[focusIndex];
        if (isNumericRow(row)) {
          mutate(r => {
            r[row] = defaultRouter[row];
          });
        } else if (row === 'systemPrompt') {
          mutate(r => {
            r.systemPrompt = defaultRouter.systemPrompt;
          });
        }
      } else {
        const def = defaultRouter.levels[levelIndex];
        if (def) {
          mutate(r => {
            const lv = r.levels[levelIndex];
            if (lv) {
              lv.effort = def.effort;
              lv.label = def.label;
              lv.help = def.help;
            }
          });
        }
      }
      return;
    }

    // On a level row, l/h open inline edit of its label/help.
    if (!isSettingRow && (input === 'l' || input === 'h')) {
      const kind = input === 'l' ? 'label' : 'help';
      const lv = router.levels[levelIndex];
      if (lv) setTextEdit({ kind, levelIndex, value: lv[kind] });
      return;
    }

    if (input === ' ' || key.return) {
      if (isSettingRow) {
        const row = SETTING_ROWS[focusIndex];
        if (row === 'enabled') {
          mutate(r => {
            r.enabled = !r.enabled;
          });
        } else if (row === 'pinPerTask') {
          mutate(r => {
            r.pinPerTask = !r.pinPerTask;
          });
        } else if (row === 'systemPrompt') {
          // Suspend Ink's raw mode so $EDITOR owns the TTY, then restore + redraw.
          if (isRawModeSupported) setRawMode(false);
          const edited = editTextInEditor(router.systemPrompt);
          if (isRawModeSupported) setRawMode(true);
          if (edited != null) {
            const v = edited.replace(/\s+$/, '');
            if (v && v !== router.systemPrompt)
              mutate(r => {
                r.systemPrompt = v;
              });
          }
          setRefresh(x => x + 1);
        } else {
          setEditing({ row, value: String(router[row]) });
        }
      } else {
        const idx = EFFORT_OPTIONS.findIndex(
          e => e.value === router.levels[levelIndex]?.effort
        );
        setPickerIndex(idx >= 0 ? idx : 0);
        setPicker({ levelIndex });
      }
    }
  });

  // ---------- effort sub-picker render ----------
  if (picker) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Header>
            Select effort for &quot;{router.levels[picker.levelIndex]?.label}
            &quot;
          </Header>
        </Box>
        {EFFORT_OPTIONS.map((option, index) => {
          const isSelected = index === pickerIndex;
          return (
            <Box key={index}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '❯ ' : '  '}
                {option.value}
                <Text dimColor> - {option.blurb}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  // ---------- main render ----------
  const renderSettingRow = (row: SettingRow, index: number) => {
    const isSelected = index === focusIndex;
    let label: string;
    let value: string;
    let hint = '';
    if (row === 'enabled') {
      label = 'Enabled';
      value = router.enabled ? 'on' : 'off';
    } else if (row === 'pinPerTask') {
      label = 'Pin per task';
      value = router.pinPerTask ? 'on' : 'off';
    } else if (row === 'systemPrompt') {
      label = 'System prompt';
      const isDefault = router.systemPrompt === defaultRouter.systemPrompt;
      value = `${router.systemPrompt.length} chars${isDefault ? ' (default)' : ' (customized)'} - enter to edit in $EDITOR`;
      hint =
        'opens the classifier system prompt in your $EDITOR; {LEVELS} (the tier rubric) and {MAX} are substituted at apply time · x = reset to default';
    } else {
      const meta = NUMERIC_ROWS[row];
      label = meta.label;
      if (editing?.row === row) {
        value = `${editing.value || '0'}_`;
        hint = `type a number (${meta.lo}-${meta.hi}), enter to save · esc cancel`;
      } else {
        value = `${router[row]} ${meta.unit}`;
        hint = meta.hint;
      }
    }
    return (
      <Box key={row} flexDirection="column">
        <Text color={isSelected ? 'cyan' : undefined}>
          {isSelected ? '❯ ' : '  '}
          {label}: <Text color="green">{value}</Text>
        </Text>
        {isSelected && hint ? (
          <Box marginLeft={4}>
            <Text dimColor>{hint}</Text>
          </Box>
        ) : null}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header>Complexity Effort Router [experimental]</Header>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text dimColor>
          Classifies each task by difficulty and sets the reasoning-effort
          (thinking) level to match - low for routine work, the top tier only
          for genuinely frontier problems. Runs on your current model (no model
          switch, no prompt-cache churn). Off by default.
        </Text>
        <Text dimColor>
          A one-shot Haiku side-call routes each prompt, fed a rolling TL;DR
          summary of the session plus the model in use and the level it set last
          turn (so it judges in context, not cold). Kept in ~/.tweakcc/router-
          state, restored on resume; reset and reseeded from the main
          model&apos;s summary when the conversation compacts. On a Haiku error
          it keeps the last level, else defaults high.
        </Text>
        <Text dimColor>
          Rewind-aware: it snapshots the routed state each turn, so /rewind
          (Restore conversation) cuts the summary back to the point you rewound
          to - effort and memory follow the conversation instead of carrying
          rewound-away work. (Summarize-from-here rewinds reseed via
          compaction.)
        </Text>
        <Text dimColor>
          Fully customizable: edit the classifier System prompt in your $EDITOR,
          and each tier&apos;s label/help inline - all with sane defaults.
        </Text>
        <Text dimColor>
          pin per task is a monotonic floor - effort never drops below the
          session max (only escalates); turn it off to track each prompt up and
          down. Reset on /clear.
        </Text>
        <Text dimColor>
          While on, the router drives effort, overriding your saved effortLevel.
          An in-session /effort takes back manual control for that session, and
          CLAUDE_CODE_EFFORT_LEVEL always wins.
        </Text>
        <Text dimColor>
          See it: Claude Code&apos;s working indicator already shows it live -
          e.g. &quot;thinking with max effort&quot; reflects the routed level.
          TWEAKCC_ROUTER_DEBUG=1 also logs each decision.
        </Text>
        <Text dimColor>
          ↑↓ navigate · enter/space toggle, edit, or open $EDITOR · digits set a
          number · on a tier: l/h edit label/help · x reset · esc back
        </Text>
      </Box>

      {SETTING_ROWS.map((row, i) => renderSettingRow(row, i))}

      <Box marginTop={1} marginBottom={1}>
        <Text bold>Complexity levels and their effort</Text>
      </Box>

      {router.levels.map((level, i) => {
        const index = SETTING_ROWS.length + i;
        const isSelected = index === focusIndex;
        const editingLabel =
          textEdit?.levelIndex === i && textEdit.kind === 'label';
        const editingHelp =
          textEdit?.levelIndex === i && textEdit.kind === 'help';
        return (
          <Box key={level.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '❯ ' : '  '}
                <Text bold>
                  {editingLabel ? `${textEdit.value}_` : level.label}
                </Text>
                {'  '}
                <Text color="green">{level.effort}</Text>
              </Text>
            </Box>
            <Box marginLeft={4}>
              <Text dimColor>
                {editingHelp ? `${textEdit.value}_` : level.help}
              </Text>
            </Box>
            {isSelected && !textEdit ? (
              <Box marginLeft={4}>
                <Text dimColor>
                  enter = set effort · l = edit label · h = edit help · x =
                  reset this tier
                </Text>
              </Box>
            ) : null}
            {isSelected && textEdit ? (
              <Box marginLeft={4}>
                <Text dimColor>
                  editing {textEdit.kind} - type to change · enter save · esc
                  cancel
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
