import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import { useContext, useState } from 'react';
import { SettingsContext } from '../App';
import Header from './Header';
import { RouterCredentialsView } from './RouterCredentialsView';
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
type NumericRow =
  | 'messageCap'
  | 'assistantCap'
  | 'timeoutMs'
  | 'jevTimeoutMs'
  | 'contextBudgetBytes'
  | 'summaryMaxChars';
const NUMERIC_ROWS: Record<
  NumericRow,
  { label: string; unit: string; lo: number; hi: number; hint: string }
> = {
  jevTimeoutMs: {
    label: 'Jev timeout',
    unit: 'ms',
    lo: 250,
    hi: 30000,
    hint: 'maximum routing wait; unusable responses fall back to medium',
  },
  contextBudgetBytes: {
    label: 'Jev context budget',
    unit: 'bytes',
    lo: 4000,
    hi: 28000,
    hint: 'bounds the message, summary, and recent unsummarized context',
  },
  summaryMaxChars: {
    label: 'Summary cap',
    unit: 'chars',
    lo: 500,
    hi: 12000,
    hint: 'concise scope, progress, constraints, and unresolved difficulties',
  },
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
    hint: 'Haiku call timeout; Jev summaries run asynchronously',
  },
};

// Settings rows that live above the per-level list.
type SettingRow =
  | 'enabled'
  | 'provider'
  | 'credentials'
  | 'pinPerTask'
  | NumericRow
  | 'systemPrompt';
const SETTING_ROWS: SettingRow[] = [
  'enabled',
  'provider',
  'credentials',
  'jevTimeoutMs',
  'contextBudgetBytes',
  'summaryMaxChars',
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
  const settingRows = SETTING_ROWS.filter(
    row =>
      (router.provider === 'jev' &&
        row !== 'systemPrompt' &&
        row !== 'pinPerTask') ||
      (router.provider !== 'jev' &&
        ![
          'credentials',
          'jevTimeoutMs',
          'contextBudgetBytes',
          'summaryMaxChars',
        ].includes(row))
  );
  const totalRows = settingRows.length + router.levels.length;
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const { setRawMode, isRawModeSupported } = useStdin();
  const [focusIndex, setFocusIndex] = useState(0);
  const { stdout } = useStdout();
  const visibleCount = Math.max(
    1,
    Math.min(totalRows, (stdout.rows || 24) - 18)
  );
  const windowStart = Math.max(
    0,
    Math.min(
      focusIndex - Math.floor(visibleCount / 2),
      totalRows - visibleCount
    )
  );
  const isVisible = (index: number) =>
    index >= windowStart && index < windowStart + visibleCount;
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
    if (credentialsOpen) return;
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
        const inputValue = Number(editing.value);
        const parsed = Math.round(inputValue);
        const n = Number.isFinite(parsed)
          ? Math.min(meta.hi, Math.max(meta.lo, parsed))
          : defaultRouter[editing.row];
        const row = editing.row;
        mutate(r => {
          Object.assign(r, { [row]: n });
        });
        setEditing(null);
        return;
      }
      if (key.backspace || key.delete) {
        setEditing(e => (e ? { ...e, value: e.value.slice(0, -1) } : e));
        return;
      }
      if (/^[0-9.]$/.test(input)) {
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

    const isSettingRow = focusIndex < settingRows.length;
    const levelIndex = focusIndex - settingRows.length;

    // 'x' resets a focused setting/prompt OR a level (label+help+effort) to default.
    if (input === 'x') {
      if (isSettingRow) {
        const row = settingRows[focusIndex];
        if (isNumericRow(row)) {
          mutate(r => {
            Object.assign(r, { [row]: defaultRouter[row] });
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
        const row = settingRows[focusIndex];
        if (row === 'enabled') {
          mutate(r => {
            r.enabled = !r.enabled;
          });
        } else if (row === 'provider') {
          mutate(r => {
            r.provider = r.provider === 'jev' ? 'haiku' : 'jev';
          });
        } else if (row === 'credentials') {
          setCredentialsOpen(true);
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

  if (credentialsOpen)
    return <RouterCredentialsView onBack={() => setCredentialsOpen(false)} />;

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
      label = 'Router model entries';
      value = router.enabled ? 'on' : 'off';
    } else if (row === 'provider') {
      label = 'Routing provider';
      value =
        router.provider === 'jev'
          ? 'Jev + asynchronous Haiku summaries'
          : 'Haiku';
      hint =
        'Jev sends your current message and concise context to TypeSafe, billed separately. Enter to switch.';
    } else if (row === 'credentials') {
      label = 'TypeSafe API key';
      value = 'enter to securely set, check, or delete';
      hint = `Model: ${router.jevModel}`;
    } else if (row === 'pinPerTask') {
      label = 'Keep highest effort this session';
      value = router.pinPerTask ? 'on' : 'off';
      hint =
        'On: effort never falls below the session maximum. Off: adapt each message. Reset on /clear.';
    } else if (row === 'systemPrompt') {
      label = 'System prompt';
      const isDefault = router.systemPrompt === defaultRouter.systemPrompt;
      value = `${router.systemPrompt.length} chars${isDefault ? ' (default)' : ' (customized)'} - enter to edit in $EDITOR`;
      hint =
        'opens the classifier system prompt in your $EDITOR; {LEVELS} (the tier rubric) and {MAX} are substituted at apply time · x = reset to default';
    } else {
      const meta = NUMERIC_ROWS[row];
      label =
        row === 'timeoutMs' && router.provider === 'jev'
          ? 'Haiku summary timeout'
          : meta.label;
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
          Apply to add Opus 5.5 and Fable 5.1 + Effort Router to /model. Select
          a router entry to enable per-message routing. Manual /effort and
          CLAUDE_CODE_EFFORT_LEVEL take precedence.
        </Text>
        {router.provider === 'jev' && (
          <Text dimColor>
            Jev receives your message and concise context. TypeSafe bills
            separately. Haiku updates summaries asynchronously.
          </Text>
        )}
        <Text dimColor>
          ↑↓ navigate · enter/space toggle, edit, or open $EDITOR · digits set a
          number · on a tier: l/h edit label/help · x reset · esc back
        </Text>
      </Box>

      {settingRows.map((row, i) =>
        isVisible(i) ? renderSettingRow(row, i) : null
      )}

      <Text dimColor>
        Showing {windowStart + 1}–{windowStart + visibleCount} of {totalRows}{' '}
        settings and effort tiers
      </Text>

      {router.levels.map((level, i) => {
        const index = settingRows.length + i;
        if (!isVisible(index)) return null;
        const isSelected = index === focusIndex;
        const editingLabel =
          textEdit?.levelIndex === i && textEdit.kind === 'label';
        const editingHelp =
          textEdit?.levelIndex === i && textEdit.kind === 'help';
        return (
          <Box key={level.id} flexDirection="column">
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
            {isSelected && (
              <Box marginLeft={4}>
                <Text dimColor>
                  {editingHelp ? `${textEdit.value}_` : level.help}
                </Text>
              </Box>
            )}
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
