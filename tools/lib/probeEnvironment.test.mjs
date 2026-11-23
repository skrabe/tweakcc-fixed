import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeCommandPrefix, probeModelEnvironmentArgs } from './probeEnvironment.mjs';

describe('probe model environment arguments', () => {
  it('leaves an absent model to the existing tmux environment', () => {
    expect(probeModelEnvironmentArgs({})).toEqual([]);
  });

  it('forwards an explicitly empty model', () => {
    expect(probeModelEnvironmentArgs({ ANTHROPIC_MODEL: '' })).toEqual([
      '-e',
      'ANTHROPIC_MODEL=',
    ]);
  });

  it('forwards each defined variable PROBE_ENV names, once', () => {
    expect(
      probeModelEnvironmentArgs({
        PROBE_ENV: 'CLAUDE_CODE_MODEL_CAPABILITIES, UNSET_ONE ANTHROPIC_MODEL',
        ANTHROPIC_MODEL: 'haiku',
        CLAUDE_CODE_MODEL_CAPABILITIES: '{"x":1}',
      })
    ).toEqual(['-e', 'ANTHROPIC_MODEL=haiku', '-e', 'CLAUDE_CODE_MODEL_CAPABILITIES={"x":1}']);
  });
});

describe('probe command prefix', () => {
  it('drops host credentials and base URL before the probed binary starts', () => {
    const r = spawnSync(
      '/bin/sh',
      ['-c', probeCommandPrefix() + 'echo "${ANTHROPIC_AUTH_TOKEN-u}${ANTHROPIC_API_KEY-u}${ANTHROPIC_BASE_URL-u}"'],
      { encoding: 'utf8', env: { ...process.env, ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://x' } }
    );
    expect(r.stdout.trim()).toBe('uuu');
  });
});

describe.skipIf(spawnSync('tmux', ['-V']).status !== 0)(
  'probe model in an existing tmux server',
  () => {
    let scratch;
    let socket;
    let count = 0;
    const tmux = (args, env = process.env) => {
      const result = spawnSync(
        'tmux',
        ['-S', socket, '-f', '/dev/null', ...args],
        {
          encoding: 'utf8',
          env,
          timeout: 5000,
        }
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };

    beforeAll(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-probe-model-'));
      socket = path.join(scratch, 'tmux.socket');
      fs.writeFileSync(
        path.join(scratch, 'model-reader.cjs'),
        'require("node:fs").writeFileSync(process.argv[2], ' +
          'JSON.stringify(process.env.ANTHROPIC_MODEL ?? null));' +
          'setInterval(() => {}, 1000);'
      );
      tmux(['new-session', '-d', '-s', 'owned-baseline', '/bin/sleep', '60'], {
        ...process.env,
        ANTHROPIC_MODEL: 'server-opus',
      });
      expect(tmux(['show-environment', '-g', 'ANTHROPIC_MODEL']).trim()).toBe(
        'ANTHROPIC_MODEL=server-opus'
      );
    });

    afterAll(() => {
      if (socket)
        spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 5000 });
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    });

    const childModel = async env => {
      const session = `owned-child-${++count}`;
      const output = path.join(scratch, `${session}.json`);
      tmux(
        [
          'new-session',
          '-d',
          '-s',
          session,
          ...probeModelEnvironmentArgs(env),
          process.execPath,
          path.join(scratch, 'model-reader.cjs'),
          output,
        ],
        { ...process.env, ANTHROPIC_MODEL: 'client-haiku' }
      );
      try {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(output) && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        expect(fs.existsSync(output)).toBe(true);
        expect(tmux(['show-environment', '-g', 'ANTHROPIC_MODEL']).trim()).toBe(
          'ANTHROPIC_MODEL=server-opus'
        );
        return JSON.parse(fs.readFileSync(output, 'utf8'));
      } finally {
        tmux(['kill-session', '-t', session]);
      }
    };

    it('passes the requested model despite a different server model', async () => {
      expect(await childModel({ ANTHROPIC_MODEL: 'haiku' })).toBe('haiku');
    });

    it('preserves server inheritance when no model was requested', async () => {
      expect(await childModel({})).toBe('server-opus');
    });

    it('passes model text literally without shell evaluation', async () => {
      const marker = path.join(scratch, 'injected');
      const model = `haiku; $(touch ${marker}) \`touch ${marker}\` "quotes"`;
      expect(await childModel({ ANTHROPIC_MODEL: model })).toBe(model);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('preserves an explicitly empty model in the child', async () => {
      expect(await childModel({ ANTHROPIC_MODEL: '' })).toBe('');
    });

    it.each(['haiku;', 'haiku;;', 'haiku\\;', 'haiku\\\\;'])(
      'preserves trailing semicolon model text %j',
      async model => {
        expect(await childModel({ ANTHROPIC_MODEL: model })).toBe(model);
      }
    );
  }
);
