/**
 * Tests for SyncthingProvider -- specifically that a failed rescan (HTTP error
 * or unreachable API) is reported as success:false rather than a silent
 * "triggered successfully".
 */

import { SyncthingProvider } from './syncthing-provider';

const baseConfig = {
  apiUrl: 'http://127.0.0.1:8384',
  apiKey: 'test-key',
  folderId: 'folder-abc',
};

describe('SyncthingProvider.sync', () => {
  afterEach(() => {
    // Remove any fetch stub between tests.
    delete (global as unknown as { fetch?: unknown }).fetch;
    jest.useRealTimers();
  });

  it('returns success:false when API key / folder ID are not configured', async () => {
    const provider = new SyncthingProvider({ apiUrl: baseConfig.apiUrl, apiKey: '', folderId: '' });
    const result = await provider.sync();
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns success:false on a non-ok rescan response (e.g. 403 bad API key)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403 });
    const provider = new SyncthingProvider(baseConfig);
    const result = await provider.sync();
    expect(result.success).toBe(false);
    expect(result.summary).toContain('403');
  });

  it('returns success:false when the Syncthing API is unreachable', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new SyncthingProvider(baseConfig);
    const result = await provider.sync();
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('ECONNREFUSED');
  });

  it('returns success:true on a 200 rescan', async () => {
    jest.useFakeTimers();
    (global as unknown as { fetch: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
    const provider = new SyncthingProvider(baseConfig);
    const promise = provider.sync();
    await jest.runAllTimersAsync(); // fast-forward the rescan-settle delay
    const result = await promise;
    expect(result.success).toBe(true);
  });
});
