import { Box, Text, useInput } from 'ink';
import { useContext, useEffect, useMemo, useState } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import matter from 'gray-matter';

import { SettingsContext } from '../App';
import { SYSTEM_REMINDERS_DIR } from '../../config';
import { openInExplorer } from '../../utils';
import Header from './Header';

interface SystemRemindersViewProps {
  onSubmit: () => void;
}

type EntryState = 'default' | 'customized' | 'suppressed' | 'missing';

interface OverrideEntry {
  id: string;
  filename: string;
  name: string;
  description: string;
  state: EntryState;
  body: string;
}

const ITEMS_PER_PAGE = 8;

const parseEntry = (filename: string): OverrideEntry | null => {
  const filePath = path.join(SYSTEM_REMINDERS_DIR, filename);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = matter(raw, { delimiters: ['<!--', '-->'] });
  const data = parsed.data as Record<string, unknown>;
  const body = (parsed.content ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
  const id = filename.replace(/\.md$/, '');
  const name = typeof data.name === 'string' ? data.name : id;
  const description =
    typeof data.description === 'string' ? data.description : '';
  let state: EntryState;
  if (body.trim().length === 0) state = 'suppressed';
  else state = 'default';
  return { id, filename, name, description, state, body };
};

const loadEntries = (): OverrideEntry[] => {
  if (!fs.existsSync(SYSTEM_REMINDERS_DIR)) return [];
  const files = fs
    .readdirSync(SYSTEM_REMINDERS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
  const entries: OverrideEntry[] = [];
  for (const f of files) {
    const e = parseEntry(f);
    if (e) entries.push(e);
  }
  return entries;
};

const stateColor: Record<EntryState, string | undefined> = {
  default: undefined,
  customized: 'cyan',
  suppressed: 'green',
  missing: 'red',
};

const stateGlyph: Record<EntryState, string> = {
  default: '·',
  customized: '◆',
  suppressed: '☑',
  missing: '?',
};

const stateLabel: Record<EntryState, string> = {
  default: 'default',
  customized: 'customized',
  suppressed: 'suppressed',
  missing: 'missing',
};

export function SystemRemindersView({ onSubmit }: SystemRemindersViewProps) {
  const { settings, updateSettings } = useContext(SettingsContext);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [entries, setEntries] = useState<OverrideEntry[]>([]);
  const [pendingWarning, setPendingWarning] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    setEntries(loadEntries());
  }, [refreshTick]);

  const deferredToolsSuppressed = settings.misc?.suppressDeferredTools ?? false;

  const totalItems = entries.length;
  const maxIndex = Math.max(0, totalItems - 1);

  const scrollOffset = useMemo(() => {
    if (selectedIndex < ITEMS_PER_PAGE) return 0;
    return Math.min(
      selectedIndex - ITEMS_PER_PAGE + 1,
      Math.max(0, totalItems - ITEMS_PER_PAGE)
    );
  }, [selectedIndex, totalItems]);

  const visibleEntries = entries.slice(
    scrollOffset,
    scrollOffset + ITEMS_PER_PAGE
  );
  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + ITEMS_PER_PAGE < totalItems;

  useInput((input, key) => {
    if (pendingWarning) {
      if (key.return) {
        updateSettings(s => {
          if (!s.misc) {
            s.misc = { suppressDeferredTools: true } as typeof s.misc;
          } else {
            s.misc.suppressDeferredTools = true;
          }
        });
        setPendingWarning(false);
      } else if (key.escape) {
        setPendingWarning(false);
      }
      return;
    }

    if (key.escape) {
      onSubmit();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
    } else if (input === 'o' || key.return) {
      const entry = entries[selectedIndex];
      if (entry) {
        openInExplorer(path.join(SYSTEM_REMINDERS_DIR, entry.filename));
      }
    } else if (input === 'd') {
      const entry = entries[selectedIndex];
      if (entry) {
        try {
          fs.unlinkSync(path.join(SYSTEM_REMINDERS_DIR, entry.filename));
          setRefreshTick(t => t + 1);
        } catch {
          // ignore
        }
      }
    } else if (input === 'r') {
      setRefreshTick(t => t + 1);
    } else if (input === 'f') {
      if (deferredToolsSuppressed) {
        updateSettings(s => {
          if (s.misc) s.misc.suppressDeferredTools = false;
        });
      } else {
        setPendingWarning(true);
      }
    }
  });

  if (pendingWarning) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Box
          borderStyle="double"
          borderColor="yellow"
          padding={2}
          flexDirection="column"
        >
          <Box marginBottom={1}>
            <Text bold color="yellow">
              FOOTGUN TOGGLE
            </Text>
          </Box>
          <Box marginBottom={1} flexDirection="column">
            <Text>
              Suppressing this hides MCP servers, Cron jobs, EnterPlanMode,
              WebFetch, Monitor, and other <Text bold>deferred</Text> tools from
              the model.
            </Text>
            <Text>
              The model only learns these tools exist via this announcement.
              Without it, it cannot call <Text bold>ToolSearch</Text> to load
              their schemas and will report capabilities as unavailable.
            </Text>
          </Box>
          <Box>
            <Text>
              Press <Text color="red">Enter</Text> to enable,{' '}
              <Text color="green">Escape</Text> to cancel
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const dirDisplay = SYSTEM_REMINDERS_DIR.replace(os.homedir(), '~');
  const selectedEntry = entries[selectedIndex];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header>System Reminders</Header>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text>
          Edit per-turn / per-event <Text bold>{'<system-reminder>'}</Text>{' '}
          injections via <Text bold>.md files</Text> in {dirDisplay}/
        </Text>
        <Text dimColor>
          Empty body = suppress · Custom body = override · Files seeded on first
          --apply. Re-apply after editing.
        </Text>
      </Box>

      {totalItems === 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">
            No override files yet. Run <Text bold>tweakcc --apply</Text> to seed
            defaults.
          </Text>
        </Box>
      ) : (
        <>
          {hasMoreAbove && (
            <Box>
              <Text dimColor> ↑ {scrollOffset} more above</Text>
            </Box>
          )}
          {visibleEntries.map((entry, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === selectedIndex;
            return (
              <Box key={entry.id} flexDirection="row">
                <Box width={2}>
                  <Text color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '❯ ' : '  '}
                  </Text>
                </Box>
                <Box width={3}>
                  <Text color={stateColor[entry.state]}>
                    {stateGlyph[entry.state]}
                  </Text>
                </Box>
                <Box width={14}>
                  <Text dimColor color={stateColor[entry.state]}>
                    {stateLabel[entry.state]}
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
          {hasMoreBelow && (
            <Box>
              <Text dimColor>
                {' '}
                ↓ {totalItems - scrollOffset - ITEMS_PER_PAGE} more below
              </Text>
            </Box>
          )}
        </>
      )}

      {selectedEntry && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text dimColor>{selectedEntry.description}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          ↑/↓ navigate · <Text bold>o</Text>/Enter open in editor ·{' '}
          <Text bold>d</Text> delete (reset on next --apply) ·{' '}
          <Text bold>r</Text> reload
        </Text>
        <Text dimColor>
          <Text bold>f</Text> toggle deferred-tools footgun [
          <Text
            color={deferredToolsSuppressed ? 'red' : undefined}
            bold={deferredToolsSuppressed}
          >
            {deferredToolsSuppressed ? 'SUPPRESSED' : 'vanilla'}
          </Text>
          ] · Esc go back
        </Text>
      </Box>
    </Box>
  );
}
