import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchLatestBridgeVersion,
  isNewerVersion,
} from './browserBridgeUpdate';

describe('isNewerVersion', () => {
  it('compares each part numerically', () => {
    expect(isNewerVersion('0.15.0', '0.12.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });
  it('is false for the same or an older version', () => {
    expect(isNewerVersion('0.15.0', '0.15.0')).toBe(false);
    expect(isNewerVersion('0.14.0', '0.15.0')).toBe(false);
  });
  it('is false for anything that is not x.y.z', () => {
    expect(isNewerVersion('dev', '0.15.0')).toBe(false);
    expect(isNewerVersion('0.15', '0.14.0')).toBe(false);
  });
});

describe('fetchLatestBridgeVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the manifest version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ version: '0.16.0' })))
    );
    expect(await fetchLatestBridgeVersion()).toBe('0.16.0');
  });
  it('returns null when offline or the payload is wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await fetchLatestBridgeVersion()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"version":"latest"}'))
    );
    expect(await fetchLatestBridgeVersion()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    );
    expect(await fetchLatestBridgeVersion()).toBeNull();
  });
});
