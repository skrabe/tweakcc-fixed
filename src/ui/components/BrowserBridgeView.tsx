import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';

import { CONFIG_DIR } from '@/config';

import { SelectInput, SelectItem } from './SelectInput';

// The bridge (extension + host + skill + installer) lives in its own repo. tweakcc fetches it
// to a stable path and shells out to its installer, which does all the scoped config writes,
// the disable-with-state-tracking, and the socket verify. No cli.js patch — pure config + files.
const REPO = 'https://github.com/skrabe/claude-browser-bridge';
const BRIDGE_DIR = path.join(CONFIG_DIR, 'claude-browser-bridge');
const SETUP = path.join(BRIDGE_DIR, 'host', 'setup.mjs');
const EXT_DIR = path.join(BRIDGE_DIR, 'extension');
const STATE_FILE = path.join(
  os.homedir(),
  '.claude-browser-bridge',
  'install-state.json'
);
// Must match the host exactly. The host hardcodes /tmp (not os.tmpdir(), which on macOS resolves to
// a per-user /var/folders/… path) — mirror that or the status check reads the wrong path.
const SOCK = `/tmp/claude-browser-bridge-${os.userInfo().username}.sock`;

// Structural browser detection, mirroring isUserDataDir() in the bridge's host/setup.mjs —
// no hardcoded browser list, so new Chromium forks (Arc, Aside, Helium, …) qualify
// automatically. A user-data dir has run at least once (Local State), owns a real profile
// (Default / "Profile N"), and has the native-messaging surface (NativeMessagingHosts,
// created by Chromium on first run). Electron apps and Firefox fail these checks.
function isUserDataDir(d: string): boolean {
  try {
    if (!fs.statSync(path.join(d, 'Local State')).isFile()) return false;
    if (!fs.statSync(path.join(d, 'NativeMessagingHosts')).isDirectory())
      return false;
    if (fs.existsSync(path.join(d, 'Default'))) return true;
    return fs.readdirSync(d).some(n => /^Profile \d+$/.test(n));
  } catch {
    return false;
  }
}
function browserLabel(dir: string): string {
  let n = path.basename(dir);
  if (n === 'User Data') n = path.basename(path.dirname(dir));
  if (n.includes('.')) n = n.split('.').pop() || n; // net.imput.helium -> helium
  n = n.replace(/[-_]/g, ' ');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

type Screen =
  | 'menu'
  | 'scope'
  | 'busy'
  | 'extmodal'
  | 'done'
  | 'howto'
  | 'confirm-uninstall'
  | 'uninstall-done'
  | 'error';

interface InstallState {
  version: string;
  scope: string;
  project?: string;
  browsers: string[];
}

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = !err
          ? 0
          : typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1;
        resolve({ code, out: String(stdout) + String(stderr) });
      }
    );
  });
}
function git(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, out: String(stdout) + String(stderr) });
      }
    );
  });
}
// Ensure a clean, up-to-date clone at BRIDGE_DIR. Handles three states: fresh (clone), valid repo
// (pull to update — this is what makes Reinstall/Repair fetch fixes), and partial/broken (a dir
// exists but git clone would abort on it, or SETUP is missing → wipe and re-clone).
async function fetchBridge(): Promise<{ code: number; out: string }> {
  const isRepo = fs.existsSync(path.join(BRIDGE_DIR, '.git'));
  if (isRepo && fs.existsSync(SETUP)) {
    const p = await git(['-C', BRIDGE_DIR, 'pull', '--ff-only']);
    // A pull failure (offline, diverged) is non-fatal — we still have a working checkout.
    return fs.existsSync(SETUP) ? { code: 0, out: p.out } : p;
  }
  if (fs.existsSync(BRIDGE_DIR))
    fs.rmSync(BRIDGE_DIR, { recursive: true, force: true });
  return git(['clone', '--depth', '1', REPO, BRIDGE_DIR]);
}
function detected(): string[] {
  const root =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config');
  const subdirs = (d: string): string[] => {
    try {
      return fs
        .readdirSync(d, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => path.join(d, e.name));
    } catch {
      return [];
    }
  };
  const found: string[] = [];
  for (const d1 of subdirs(root))
    for (const c of [d1, ...subdirs(d1)])
      if (isUserDataDir(c)) found.push(browserLabel(c));
  return found.sort();
}
function readState(): InstallState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export const BrowserBridgeView = ({ onBack }: { onBack: () => void }) => {
  const [screen, setScreen] = useState<Screen>('menu');
  const [sel, setSel] = useState(0);
  const [state, setState] = useState<InstallState | null>(readState());
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [busyMsg, setBusyMsg] = useState('Working…');
  const [log, setLog] = useState<string[]>([]);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [err, setErr] = useState<string>('');

  const refresh = useCallback(() => {
    setState(readState());
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const socketUp = fs.existsSync(SOCK);
  const installed = !!state;

  const goInstall = () => {
    setScope('global');
    setSel(0);
    setScreen('scope');
  };

  const doInstall = useCallback(
    async (sc: 'global' | 'project') => {
      setScreen('busy');
      setBusyMsg('Fetching the bridge…');
      setLog([]);
      const c = await fetchBridge();
      if (c.code !== 0 || !fs.existsSync(SETUP)) {
        setErr('Failed to fetch the bridge repo:\n' + c.out.slice(-600));
        setScreen('error');
        return;
      }
      setBusyMsg(
        'Installing (registers with every Chromium browser, MCP, skill, disables Claude in Chrome)…'
      );
      const args = [SETUP, 'install', '--scope', sc];
      if (sc === 'project') args.push('--project', process.cwd());
      const r = await run(args);
      setLog(
        r.out
          .split('\n')
          .filter(l => l.includes('[bridge]'))
          .map(l => l.replace('[bridge]', '').trim())
      );
      if (r.code !== 0) {
        setErr('Install failed:\n' + r.out.slice(-600));
        setScreen('error');
        return;
      }
      refresh();
      setSel(0);
      setScreen('extmodal');
    },
    [refresh]
  );

  const doVerify = useCallback(async () => {
    setScreen('busy');
    setBusyMsg('Connecting to the extension…');
    setVerifyErr(null);
    const r = await run([SETUP, 'verify']);
    if (r.code === 0) {
      setSel(0);
      setScreen('done');
    } else {
      setVerifyErr(
        'Not detected. Make sure the extension is loaded AND enabled, then retry.'
      );
      setSel(0);
      setScreen('extmodal');
    }
  }, []);

  const doUninstall = useCallback(async () => {
    setScreen('busy');
    setBusyMsg('Uninstalling…');
    const r = await run([SETUP, 'uninstall']);
    setLog(
      r.out
        .split('\n')
        .filter(l => l.includes('[bridge]'))
        .map(l => l.replace('[bridge]', '').trim())
    );
    if (r.code !== 0) {
      setErr('Uninstall failed:\n' + r.out.slice(-600));
      refresh();
      setScreen('error');
      return;
    }
    // Remove the cloned repo too — it only exists because Install fetched it, and the extension
    // was loaded from it (so removing it also invalidates the unpacked extension in the browser).
    fs.rmSync(BRIDGE_DIR, { recursive: true, force: true }); // force:true → no throw if already gone
    refresh();
    setSel(0);
    setScreen('uninstall-done');
  }, [refresh]);

  useInput((_input, key) => {
    if (key.escape) {
      if (screen === 'menu') onBack();
      else if (screen !== 'busy') {
        setSel(0);
        setScreen('menu');
      } // busy: ignore Esc
    }
  });

  // ---------- render ----------
  if (screen === 'busy')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">
          Better Claude in Chrome
        </Text>
        <Text>
          <Text color="yellow">◐ </Text>
          {busyMsg}
        </Text>
        {log.slice(-8).map((l, i) => (
          <Text key={i} dimColor>
            {' '}
            {l}
          </Text>
        ))}
      </Box>
    );

  if (screen === 'error')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="red">
          Better Claude in Chrome — error
        </Text>
        <Text color="red">{err}</Text>
        <Text dimColor>Esc to go back</Text>
      </Box>
    );

  if (screen === 'scope') {
    const items: SelectItem[] = [
      {
        name: 'Global',
        desc: 'skill in ~/.claude/skills, MCP user scope, disable Claude in Chrome everywhere',
      },
      {
        name: `Project (${path.basename(process.cwd())})`,
        desc: `only for ${process.cwd()} — .mcp.json + project .claude/skills + disable only here`,
      },
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">
          Install — choose scope
        </Text>
        <SelectInput
          items={items}
          selectedIndex={sel}
          onSelect={setSel}
          onSubmit={name => {
            const sc = name.startsWith('Global') ? 'global' : 'project';
            setScope(sc);
            void doInstall(sc);
          }}
        />
        <Text dimColor>Esc to cancel</Text>
      </Box>
    );
  }

  if (screen === 'extmodal') {
    const items: SelectItem[] = [
      { name: "I've loaded it →" },
      { name: 'Cancel' },
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">
          Load the extension (one-time)
        </Text>
        <Box flexDirection="column">
          <Text>
            1. Open <Text color="yellow">brave://extensions</Text> (or
            chrome://extensions)
          </Text>
          <Text>
            2. Turn on <Text bold>Developer mode</Text> (top right)
          </Text>
          <Text>
            3. <Text bold>Load unpacked</Text> →{' '}
            <Text color="yellow">{EXT_DIR}</Text>
          </Text>
          <Text>
            4. Make sure it is toggled <Text bold>ON</Text>
          </Text>
        </Box>
        {verifyErr && <Text color="red">{verifyErr}</Text>}
        <SelectInput
          items={items}
          selectedIndex={sel}
          onSelect={setSel}
          onSubmit={name => {
            if (name === 'Cancel') {
              setSel(0);
              setScreen('menu');
            } else void doVerify();
          }}
        />
      </Box>
    );
  }

  if (screen === 'done')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="green">
          Done. The browser bridge is live.
        </Text>
        <Text>
          Claude in Chrome is disabled ({state?.scope || scope}). One browser
          surface now.
        </Text>
        <Box flexDirection="column">
          <Text>
            <Text bold>Use it:</Text> ask Claude to do browser work, or run{' '}
            <Text color="cyan">/browser</Text> for the full playbook.
          </Text>
          <Text dimColor>
            tabs_list · tab_claim · navigate · read_page · find · screenshot ·
            cdp · …
          </Text>
          <Text dimColor>
            Restart Claude Code so it picks up the tools and drops Claude in
            Chrome.
          </Text>
        </Box>
        <SelectInput
          items={[{ name: 'Back' }]}
          selectedIndex={0}
          onSelect={() => {}}
          onSubmit={() => {
            refresh();
            setSel(0);
            setScreen('menu');
          }}
        />
      </Box>
    );

  if (screen === 'howto')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">
          How it works
        </Text>
        <Text>
          Claude drives your <Text bold>real, logged-in</Text> browser over the
          Chrome DevTools
        </Text>
        <Text>
          Protocol through a small extension you load once. Same technique as
          Claude in
        </Text>
        <Text>
          Chrome and tools like it — but pointed at your existing tabs, not a
          fresh
        </Text>
        <Text>
          sandbox, and it is all yours. Nothing listens on a network port.
        </Text>
        <Text> </Text>
        <Text>
          {' '}
          Claude Code ─MCP→ local host ─native messaging→ extension ─CDP→ your
          tabs
        </Text>
        <Text> </Text>
        <Text>
          <Text bold>vs Claude in Chrome:</Text> sees + claims your existing
          signed-in tabs (it only opens
        </Text>
        <Text>
          new ones), full raw CDP, and the playbook ships as the{' '}
          <Text color="cyan">/browser</Text> skill.
        </Text>
        <Text> </Text>
        <Text>
          While on, Claude in Chrome is disabled for the scope you chose.
          Uninstall
        </Text>
        <Text>restores it — but only if we were the one who disabled it.</Text>
        <Text> </Text>
        <Text dimColor>Esc to go back</Text>
      </Box>
    );

  if (screen === 'confirm-uninstall') {
    const items: SelectItem[] = [
      {
        name: 'Yes, uninstall',
        desc: 'removes MCP, skill, native host; re-enables Claude in Chrome if we disabled it',
      },
      { name: 'Cancel' },
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="yellow">
          Uninstall the browser bridge?
        </Text>
        <SelectInput
          items={items}
          selectedIndex={sel}
          onSelect={setSel}
          onSubmit={name => {
            if (name === 'Cancel') {
              setSel(0);
              setScreen('menu');
            } else void doUninstall();
          }}
        />
      </Box>
    );
  }

  if (screen === 'uninstall-done')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="green">
          Uninstalled.
        </Text>
        {log.map((l, i) => (
          <Text key={i} dimColor>
            {' '}
            {l}
          </Text>
        ))}
        <Text>
          Removed our MCP entry, skill, native-host manifests, and the local
          repo. Claude in Chrome is back on (unless you had it off before us).
        </Text>
        <Text color="yellow">
          One step we can&apos;t do for you: open{' '}
          <Text bold>brave://extensions</Text> and Remove the &quot;Better
          Claude in Chrome&quot; extension (its files are now gone, so it will
          show an error until you do).
        </Text>
        <SelectInput
          items={[{ name: 'Back' }]}
          selectedIndex={0}
          onSelect={() => {}}
          onSubmit={() => {
            setSel(0);
            setScreen('menu');
          }}
        />
      </Box>
    );

  // menu
  const actions: SelectItem[] = [];
  if (!installed)
    actions.push({
      name: 'Set up',
      desc: 'fetch, configure, and connect the bridge',
    });
  else {
    actions.push({
      name: 'Reinstall / Repair',
      desc: 're-run setup with current or new options',
    });
    actions.push({
      name: 'Uninstall',
      desc: 'remove everything, restore Claude in Chrome',
    });
  }
  actions.push({ name: 'How it works' });
  actions.push({ name: 'Back' });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        Better Claude in Chrome
      </Text>
      <Text dimColor>
        A better Claude in Chrome — drives your real, logged-in tabs over CDP.
        Owned, local, no network port.
      </Text>
      <Box flexDirection="column">
        <Text>Status</Text>
        <Text>
          {' '}
          Installed .........{' '}
          {installed ? (
            <Text color="green">
              yes ({state?.scope}, v{state?.version})
            </Text>
          ) : (
            <Text dimColor>no</Text>
          )}
        </Text>
        <Text>
          {' '}
          Extension .........{' '}
          {socketUp ? (
            <Text color="green">connected</Text>
          ) : (
            <Text dimColor>not detected</Text>
          )}
        </Text>
        <Text> Browsers found .... {detected().join(', ') || 'none'}</Text>
      </Box>
      <SelectInput
        items={actions}
        selectedIndex={sel}
        onSelect={setSel}
        onSubmit={name => {
          if (name === 'Set up' || name.startsWith('Reinstall')) goInstall();
          else if (name === 'Uninstall') {
            setSel(0);
            setScreen('confirm-uninstall');
          } else if (name === 'How it works') setScreen('howto');
          else onBack();
        }}
      />
      <Text dimColor>Esc to go back</Text>
    </Box>
  );
};

export default BrowserBridgeView;
