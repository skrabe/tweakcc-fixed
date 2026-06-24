import { Box, Text, useInput } from 'ink';
import { useContext, useState } from 'react';
import { SettingsContext } from '../App';
import Header from './Header';
import { DEFAULT_SETTINGS } from '../../defaultSettings';
import {
  ComplexityRouterConfig,
  RouterClassifierMode,
  RouterEffort,
} from '../../types';

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

// Settings rows that live above the per-level list.
type SettingRow = 'enabled' | 'mode' | 'pinPerTask';
const SETTING_ROWS: SettingRow[] = ['enabled', 'mode', 'pinPerTask'];

type SubPicker = { levelIndex: number } | null;

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
  const [focusIndex, setFocusIndex] = useState(0);
  const [picker, setPicker] = useState<SubPicker>(null);
  const [pickerIndex, setPickerIndex] = useState(0);

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

    // 'x' resets a focused level to its default effort.
    if (input === 'x' && !isSettingRow) {
      const def = defaultRouter.levels[levelIndex];
      if (def) {
        mutate(r => {
          if (r.levels[levelIndex]) r.levels[levelIndex].effort = def.effort;
        });
      }
      return;
    }

    if (input === ' ' || key.return) {
      if (isSettingRow) {
        const row = SETTING_ROWS[focusIndex];
        if (row === 'enabled') {
          mutate(r => {
            r.enabled = !r.enabled;
          });
        } else if (row === 'mode') {
          mutate(r => {
            const next: RouterClassifierMode =
              r.mode === 'heuristic' ? 'llm' : 'heuristic';
            r.mode = next;
          });
        } else if (row === 'pinPerTask') {
          mutate(r => {
            r.pinPerTask = !r.pinPerTask;
          });
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
    if (row === 'enabled') {
      label = 'Enabled';
      value = router.enabled ? 'on' : 'off';
    } else if (row === 'mode') {
      label = 'Classifier mode';
      value = router.mode;
    } else {
      label = 'Pin per task';
      value = router.pinPerTask ? 'on' : 'off';
    }
    return (
      <Box key={row}>
        <Text color={isSelected ? 'cyan' : undefined}>
          {isSelected ? '❯ ' : '  '}
          {label}: <Text color="green">{value}</Text>
        </Text>
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
          (thinking) level to match - low effort for routine work, max for the
          hardest. Runs on your current model (no model switch, no prompt-cache
          churn). Off by default.
        </Text>
        <Text dimColor>
          heuristic mode is instant; llm mode adds a one-shot Haiku classifier
          call at the task boundary (fails back to heuristic). pin per task
          keeps effort stable for a session (only escalates); turn it off to
          re-rate every prompt.
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
          ↑↓ navigate · enter/space change · x reset level · esc back
        </Text>
      </Box>

      {SETTING_ROWS.map((row, i) => renderSettingRow(row, i))}

      <Box marginTop={1} marginBottom={1}>
        <Text bold>Complexity levels and their effort</Text>
      </Box>

      {router.levels.map((level, i) => {
        const index = SETTING_ROWS.length + i;
        const isSelected = index === focusIndex;
        return (
          <Box key={level.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '❯ ' : '  '}
                <Text bold>{level.label}</Text>
                {'  '}
                <Text color="green">{level.effort}</Text>
              </Text>
            </Box>
            <Box marginLeft={4}>
              <Text dimColor>{level.help}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
