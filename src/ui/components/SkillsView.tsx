import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import Header from './Header';

interface SkillsViewProps {
  onSubmit: () => void;
}

type SkillState = 'on' | 'name-only' | 'user-invocable-only' | 'off';

const STATE_CYCLE: SkillState[] = [
  'on',
  'name-only',
  'user-invocable-only',
  'off',
];

const STATE_LABEL: Record<SkillState, string> = {
  on: 'on (full description)',
  'name-only': 'name-only (model sees no description)',
  'user-invocable-only':
    'user-invocable (hidden from model, /name still works)',
  off: 'off (not loaded)',
};

const STATE_COLOR: Record<SkillState, string | undefined> = {
  on: undefined,
  'name-only': 'cyan',
  'user-invocable-only': 'yellow',
  off: 'red',
};

const STATE_GLYPH: Record<SkillState, string> = {
  on: '◉',
  'name-only': '◐',
  'user-invocable-only': '◑',
  off: '○',
};

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const SKILL_DIRS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
];

const ITEMS_PER_PAGE = 10;

interface SkillEntry {
  name: string;
  state: SkillState;
}

const cycleNext = (s: SkillState): SkillState => {
  const i = STATE_CYCLE.indexOf(s);
  return STATE_CYCLE[(i + 1) % STATE_CYCLE.length];
};

const cyclePrev = (s: SkillState): SkillState => {
  const i = STATE_CYCLE.indexOf(s);
  return STATE_CYCLE[(i - 1 + STATE_CYCLE.length) % STATE_CYCLE.length];
};

const discoverSkills = (): string[] => {
  const found = new Set<string>();
  for (const dir of SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() || e.isSymbolicLink()) found.add(e.name);
      }
    } catch {
      // ignore
    }
  }
  return [...found].sort();
};

const readSettings = (): { skillOverrides: Record<string, SkillState> } => {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      skillOverrides?: Record<string, SkillState>;
    };
    return { skillOverrides: parsed.skillOverrides ?? {} };
  } catch {
    return { skillOverrides: {} };
  }
};

const writeSettings = (overrides: Record<string, SkillState>): void => {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // empty
  }
  parsed.skillOverrides = overrides;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2));
};

export function SkillsView({ onSubmit }: SkillsViewProps) {
  const [overrides, setOverrides] = useState<Record<string, SkillState>>({});
  const [skills, setSkills] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    setSkills(discoverSkills());
    setOverrides(readSettings().skillOverrides);
  }, []);

  const entries: SkillEntry[] = useMemo(
    () =>
      skills.map(name => ({
        name,
        state: overrides[name] ?? 'on',
      })),
    [skills, overrides]
  );

  const total = entries.length;
  const maxIndex = Math.max(0, total - 1);

  const scrollOffset = useMemo(() => {
    if (selectedIndex < ITEMS_PER_PAGE) return 0;
    return Math.min(
      selectedIndex - ITEMS_PER_PAGE + 1,
      Math.max(0, total - ITEMS_PER_PAGE)
    );
  }, [selectedIndex, total]);

  const visible = entries.slice(scrollOffset, scrollOffset + ITEMS_PER_PAGE);

  const updateState = (idx: number, newState: SkillState) => {
    const name = entries[idx]?.name;
    if (!name) return;
    const next = { ...overrides };
    if (newState === 'on') {
      delete next[name];
    } else {
      next[name] = newState;
    }
    setOverrides(next);
    writeSettings(next);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 1500);
  };

  useInput((input, key) => {
    if (key.escape || (key.return && total === 0)) {
      onSubmit();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
    } else if (input === ' ' || key.rightArrow) {
      const cur = entries[selectedIndex]?.state ?? 'on';
      updateState(selectedIndex, cycleNext(cur));
    } else if (key.leftArrow) {
      const cur = entries[selectedIndex]?.state ?? 'on';
      updateState(selectedIndex, cyclePrev(cur));
    } else if (input === '0') {
      updateState(selectedIndex, 'on');
    } else if (input === 'x') {
      updateState(selectedIndex, 'off');
    }
  });

  const selected = entries[selectedIndex];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header>Skills (per-skill skillOverrides)</Header>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text>
          Writes <Text bold>skillOverrides</Text> to{' '}
          <Text color="cyan">~/.claude/settings.json</Text> — CC reads this
          natively, no tweakcc patch needed.
        </Text>
        <Text dimColor>
          Each skill: on / name-only / user-invocable-only / off. CC honors
          immediately; no --apply required.
        </Text>
      </Box>

      {total === 0 ? (
        <Box>
          <Text color="yellow">
            No skills found in{' '}
            {SKILL_DIRS.map(d => d.replace(os.homedir(), '~')).join(' or ')}.
          </Text>
        </Box>
      ) : (
        <>
          {scrollOffset > 0 && (
            <Box>
              <Text dimColor> ↑ {scrollOffset} more above</Text>
            </Box>
          )}
          {visible.map((entry, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === selectedIndex;
            return (
              <Box key={entry.name} flexDirection="row">
                <Box width={2}>
                  <Text color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '❯ ' : '  '}
                  </Text>
                </Box>
                <Box width={3}>
                  <Text color={STATE_COLOR[entry.state]}>
                    {STATE_GLYPH[entry.state]}
                  </Text>
                </Box>
                <Box width={26}>
                  <Text dimColor color={STATE_COLOR[entry.state]}>
                    {entry.state}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? 'cyan' : undefined}
                  >
                    {entry.name}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {scrollOffset + ITEMS_PER_PAGE < total && (
            <Box>
              <Text dimColor>
                {' '}
                ↓ {total - scrollOffset - ITEMS_PER_PAGE} more below
              </Text>
            </Box>
          )}
        </>
      )}

      {selected && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{STATE_LABEL[selected.state]}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          ↑/↓ navigate · space/→/← cycle state · <Text bold>0</Text> set on ·{' '}
          <Text bold>x</Text> set off · Esc back
        </Text>
        {showSaved && <Text color="green">✓ saved to settings.json</Text>}
      </Box>
    </Box>
  );
}
