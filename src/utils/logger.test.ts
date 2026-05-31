/**
 * Tests for secret redaction in the logger. Commands run over SSH can embed
 * the Syncthing API key or a password; these must never reach the console.
 */

import { redactSecrets } from './logger';

describe('redactSecrets', () => {
  it('masks a Syncthing X-API-Key header', () => {
    const cmd = `curl -s -H 'X-API-Key: abc123SECRETkey' 'http://127.0.0.1:8384/rest/config'`;
    const out = redactSecrets(cmd);
    expect(out).not.toContain('abc123SECRETkey');
    expect(out).toContain('X-API-Key: ***');
  });

  it('masks SSHPASS env and sshpass -p', () => {
    expect(redactSecrets('SSHPASS=hunter2 rsync ...')).toBe('SSHPASS=*** rsync ...');
    expect(redactSecrets('sshpass -p hunter2 ssh root@host')).toBe('sshpass -p *** ssh root@host');
  });

  it('masks --password flags', () => {
    expect(redactSecrets('tool --password hunter2')).toBe('tool --password ***');
    expect(redactSecrets('tool --password=hunter2')).toBe('tool --password=***');
  });

  it('leaves ordinary messages untouched', () => {
    const msg = 'SFTP sync: 3 to download, 12 up to date';
    expect(redactSecrets(msg)).toBe(msg);
  });
});
