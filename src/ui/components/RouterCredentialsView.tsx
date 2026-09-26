import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import {
  deleteRouterApiKey,
  hasRouterApiKey,
  setRouterApiKey,
} from '../../routerCredentials';
import Header from './Header';

export function RouterCredentialsView({ onBack }: { onBack: () => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Press c to check key availability.');

  const perform = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch {
      setStatus(
        'Credential operation failed. Unlock your keychain, or install secret-tool and unlock Secret Service on Linux. For headless use, supply TYPESAFE_API_KEY through your secret manager.'
      );
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      if (secret !== null) setSecret(null);
      else onBack();
      return;
    }
    if (secret !== null) {
      if (key.return) {
        if (!secret.trim() || /[^\x21-\x7e]/.test(secret)) {
          setStatus(
            'Enter a nonempty API key without spaces or control characters.'
          );
          return;
        }
        const value = secret;
        setSecret(null);
        void perform(async () => {
          await setRouterApiKey(value);
          return 'API key saved securely.';
        });
      } else if (key.backspace || key.delete) {
        setSecret(secret.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        if (/[^\x21-\x7e]/.test(input)) {
          setStatus(
            'Paste only the API key, without spaces or control characters.'
          );
        } else if (secret.length + input.length <= 1024) {
          setSecret(secret + input);
        }
      }
      return;
    }
    if (input === 'e' || key.return) {
      setSecret('');
      setStatus('Enter to save; escape to discard.');
    } else if (input === 'c') {
      void perform(async () =>
        (await hasRouterApiKey())
          ? 'API key available.'
          : 'No API key available.'
      );
    } else if (input === 'd') {
      void perform(async () => {
        await deleteRouterApiKey();
        return 'Stored key removed. TYPESAFE_API_KEY, if set, still takes precedence.';
      });
    }
  });

  return (
    <Box flexDirection="column">
      <Header>TypeSafe API key</Header>
      <Text>Stored in your OS credential store, never router settings.</Text>
      <Text dimColor>
        Headless use: provide TYPESAFE_API_KEY through your secret manager.
      </Text>
      <Text>{busy ? 'Working…' : status}</Text>
      {secret !== null ? (
        <Text>API key: {'•'.repeat(Math.min(secret.length, 48))}_</Text>
      ) : (
        <Text dimColor>
          enter/e set key · c check · d delete stored key · esc back
        </Text>
      )}
    </Box>
  );
}
