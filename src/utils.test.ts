import { describe, it, expect } from 'vitest';
import { readResponseTextCapped, MAX_FETCH_BYTES } from './utils';

describe('readResponseTextCapped', () => {
  it('returns the body when it is under the cap', async () => {
    const out = await readResponseTextCapped(new Response('hello world'), 1024);
    expect(out).toBe('hello world');
  });

  it('reads a body exactly at the cap', async () => {
    const body = 'x'.repeat(100);
    const out = await readResponseTextCapped(new Response(body), 100);
    expect(out).toBe(body);
  });

  it('aborts a streamed body that exceeds the cap', async () => {
    // No Content-Length here, so this exercises the streaming-abort path.
    await expect(
      readResponseTextCapped(new Response('x'.repeat(5000)), 100)
    ).rejects.toThrow(/exceeds the 100-byte limit/);
  });

  it('fast-rejects an oversized Content-Length without reading the body', async () => {
    const r = new Response('tiny', {
      headers: { 'content-length': '999999' },
    });
    await expect(readResponseTextCapped(r, 100)).rejects.toThrow(/too large/);
  });

  it('defaults to a generous 32 MB cap', () => {
    expect(MAX_FETCH_BYTES).toBe(32 * 1024 * 1024);
  });
});
