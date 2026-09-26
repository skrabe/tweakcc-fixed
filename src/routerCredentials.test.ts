import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRouterCredentialRuntime,
  deleteRouterApiKey,
  hasRouterApiKey,
  setRouterApiKey,
} from './routerCredentials';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function platform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function respond(error: Error | null = null, stdout = '') {
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      queueMicrotask(() => callback(error, stdout));
      return { stdin: { end: mocks.end, on: mocks.on } };
    }
  );
}

function runtime(
  selectedPlatform: NodeJS.Platform,
  environment: Record<string, string> = {}
): () => Promise<string | null> {
  return runInNewContext(
    `${buildRouterCredentialRuntime('require')}; __tweakccRouterApiKey`,
    {
      process: { platform: selectedPlatform, env: environment },
      require: () => ({ execFile: mocks.execFile }),
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TYPESAFE_API_KEY', '');
  respond();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
});

describe('router credential storage', () => {
  it('stores escaped macOS credentials on stdin without exposing argv', async () => {
    platform('darwin');
    const key = 'secret"\\$(whoami);token';
    respond(null, key);
    await setRouterApiKey(key);
    expect(mocks.execFile.mock.calls[0].slice(0, 2)).toEqual([
      '/usr/bin/security',
      ['-i'],
    ]);
    expect(mocks.end).toHaveBeenCalledWith(
      'add-generic-password -U -s tweakcc-fixed.typesafe -a api-key -w "secret\\"\\\\$(whoami);token"\n'
    );
  });

  it.each([
    '',
    'secret\nquit',
    'secret\rquit',
    'secret\0key',
    'a b',
    'x'.repeat(1025),
  ])('rejects invalid keys before starting a process', async key => {
    await expect(setRouterApiKey(key)).rejects.toThrow('API key must contain');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('pipes Linux keys without adding a newline', async () => {
    platform('linux');
    respond(null, 'test-key');
    await setRouterApiKey('test-key');
    expect(mocks.execFile.mock.calls[0].slice(0, 2)).toEqual([
      'secret-tool',
      [
        'store',
        '--label=tweakcc TypeSafe API key',
        'service',
        'tweakcc-fixed.typesafe',
        'account',
        'api-key',
      ],
    ]);
    expect(mocks.end).toHaveBeenCalledWith('test-key');
  });

  it('rejects a successful store command that failed to retain the key', async () => {
    platform('darwin');
    respond(null, 'previous-key');
    await expect(setRouterApiKey('replacement-key')).rejects.toThrow(
      'did not retain the API key'
    );
  });

  it('deletes the same OS-store entry', async () => {
    platform('linux');
    await deleteRouterApiKey();
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      'clear',
      'service',
      'tweakcc-fixed.typesafe',
      'account',
      'api-key',
    ]);
  });

  it('reports backend failures without leaking subprocess error text', async () => {
    platform('linux');
    respond(new Error('secret-sensitive-output'));
    await expect(setRouterApiKey('test-key')).rejects.toThrow(
      'Could not access the OS credential store'
    );
    await expect(setRouterApiKey('test-key')).rejects.not.toThrow(
      'secret-sensitive-output'
    );
  });

  it('offers environment configuration on unsupported platforms', async () => {
    platform('win32');
    await expect(setRouterApiKey('test-key')).rejects.toThrow(
      'TYPESAFE_API_KEY'
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
    vi.stubEnv('TYPESAFE_API_KEY', 'environment-key');
    expect(await hasRouterApiKey()).toBe(true);
  });

  it('treats inaccessible or invalid stored credentials as unavailable', async () => {
    platform('darwin');
    respond(new Error('unavailable'));
    expect(await hasRouterApiKey()).toBe(false);
    respond(null, 'malformed key');
    expect(await hasRouterApiKey()).toBe(false);
    respond(null, 'valid-key\n');
    expect(await hasRouterApiKey()).toBe(true);
  });
});

describe('injected router credential reader', () => {
  it('uses the environment first without running an OS command', async () => {
    expect(await runtime('win32', { TYPESAFE_API_KEY: 'env-key' })()).toBe(
      'env-key'
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('rejects malformed environment credentials', async () => {
    expect(
      await runtime('darwin', { TYPESAFE_API_KEY: 'key\nheader' })()
    ).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)(
    'reads %s credentials with bounded execution and observes deletion',
    async selectedPlatform => {
      const read = runtime(selectedPlatform);
      respond(null, 'stored-key\n');
      expect(await read()).toBe('stored-key');
      expect(mocks.execFile.mock.calls[0][2]).toMatchObject({
        timeout: 1500,
        killSignal: 'SIGKILL',
        maxBuffer: 8192,
      });
      respond(new Error('deleted'));
      expect(await read()).toBeNull();
    }
  );

  it('handles unavailable binaries and unsupported systems', async () => {
    mocks.execFile.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(await runtime('linux')()).toBeNull();
    expect(await runtime('win32')()).toBeNull();
  });
});
