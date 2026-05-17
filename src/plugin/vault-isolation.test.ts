/**
 * Tests for vault-isolation.ts -- claim file lifecycle, collision detection,
 * stale claim handling, and outside-vault-root detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  CLAIM_FILENAME,
  CLAIMS_SUBDIR,
  STALE_CLAIM_THRESHOLD_MS,
  buildClaimContents,
  writeClaimFile,
  readClaimFile,
  removeClaimFile,
  isClaimStale,
  normalisePath,
  checkFolderForCollision,
  checkOutsideVault,
  collectManagedFolders,
  writeClaimsAndCheckCollisions,
  removeAllClaims,
  collisionKey,
  getClaimFilePath,
  hashFolderPath,
  type ClaimFileContents,
  type Collision,
} from './vault-isolation';

// -------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------

/** Create a temporary directory for test isolation. */
function makeTempDir(prefix = 'vi-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Clean up a temporary directory tree. */
function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// -------------------------------------------------------------------
// buildClaimContents
// -------------------------------------------------------------------

describe('buildClaimContents', () => {
  it('should produce valid claim contents with required fields', () => {
    const contents = buildClaimContents('/vault/path');
    expect(contents.vaultPath).toBe('/vault/path');
    expect(contents.pluginId).toBe('eink-sync');
    expect(typeof contents.timestamp).toBe('number');
    expect(contents.timestamp).toBeGreaterThan(0);
    expect(contents._note).toContain('E-Ink Sync');
  });

  it('should use current time as timestamp', () => {
    const before = Date.now();
    const contents = buildClaimContents('/test');
    const after = Date.now();
    expect(contents.timestamp).toBeGreaterThanOrEqual(before);
    expect(contents.timestamp).toBeLessThanOrEqual(after);
  });
});

// -------------------------------------------------------------------
// writeClaimFile / readClaimFile / removeClaimFile
// -------------------------------------------------------------------

describe('claim file lifecycle (legacy — in managed folder)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should write and read a claim file (legacy)', () => {
    const success = writeClaimFile(tempDir, '/my/vault');
    expect(success).toBe(true);

    const claim = readClaimFile(tempDir);
    expect(claim).not.toBeNull();
    expect(claim!.vaultPath).toBe('/my/vault');
    expect(claim!.pluginId).toBe('eink-sync');
    expect(typeof claim!.timestamp).toBe('number');
  });

  it('should return null when no claim file exists', () => {
    const claim = readClaimFile(tempDir);
    expect(claim).toBeNull();
  });

  it('should succeed when removing a non-existent claim file', () => {
    const removed = removeClaimFile(tempDir);
    expect(removed).toBe(true);
  });
});

describe('claim file lifecycle (plugin data dir)', () => {
  let tempDir: string;
  let pluginDir: string;
  let managedFolder: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = path.join(tempDir, 'plugin-data');
    managedFolder = path.join(tempDir, 'sync-folder');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(managedFolder, { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should write claim to plugin data dir, not managed folder', () => {
    const success = writeClaimFile(managedFolder, '/my/vault', pluginDir);
    expect(success).toBe(true);

    // Claim should NOT be in managed folder
    expect(fs.existsSync(path.join(managedFolder, CLAIM_FILENAME))).toBe(false);

    // Claim should be in plugin data dir
    const claimPath = getClaimFilePath(pluginDir, managedFolder);
    expect(fs.existsSync(claimPath)).toBe(true);

    const claim = readClaimFile(managedFolder, pluginDir);
    expect(claim).not.toBeNull();
    expect(claim!.vaultPath).toBe('/my/vault');
    expect(claim!.folderPath).toBe(managedFolder);
  });

  it('should overwrite an existing claim file in plugin data dir', () => {
    writeClaimFile(managedFolder, '/vault-1', pluginDir);
    writeClaimFile(managedFolder, '/vault-2', pluginDir);

    const claim = readClaimFile(managedFolder, pluginDir);
    expect(claim).not.toBeNull();
    expect(claim!.vaultPath).toBe('/vault-2');
  });

  it('should remove claim file from plugin data dir', () => {
    writeClaimFile(managedFolder, '/vault', pluginDir);
    expect(readClaimFile(managedFolder, pluginDir)).not.toBeNull();

    const removed = removeClaimFile(managedFolder, pluginDir);
    expect(removed).toBe(true);
    expect(readClaimFile(managedFolder, pluginDir)).toBeNull();
  });

  it('should also clean up legacy claim files during remove', () => {
    // Simulate a legacy claim in the managed folder
    const legacyPath = path.join(managedFolder, CLAIM_FILENAME);
    fs.writeFileSync(legacyPath, JSON.stringify(buildClaimContents('/vault')), 'utf-8');
    expect(fs.existsSync(legacyPath)).toBe(true);

    // Write new-style claim
    writeClaimFile(managedFolder, '/vault', pluginDir);

    // Remove should clean up both
    removeClaimFile(managedFolder, pluginDir);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('should return null for invalid JSON in claim file', () => {
    const claimPath = getClaimFilePath(pluginDir, managedFolder);
    fs.mkdirSync(path.dirname(claimPath), { recursive: true });
    fs.writeFileSync(claimPath, 'not json', 'utf-8');

    const claim = readClaimFile(managedFolder, pluginDir);
    expect(claim).toBeNull();
  });
});

// -------------------------------------------------------------------
// isClaimStale
// -------------------------------------------------------------------

describe('isClaimStale', () => {
  it('should return false for a fresh claim', () => {
    const claim = buildClaimContents('/vault');
    expect(isClaimStale(claim)).toBe(false);
  });

  it('should return true for a claim older than 7 days', () => {
    const claim = buildClaimContents('/vault');
    claim.timestamp = Date.now() - STALE_CLAIM_THRESHOLD_MS - 1000;
    expect(isClaimStale(claim)).toBe(true);
  });

  it('should return false for a claim exactly at the threshold', () => {
    const now = Date.now();
    const claim = buildClaimContents('/vault');
    claim.timestamp = now - STALE_CLAIM_THRESHOLD_MS;
    // At exactly the threshold, the difference is equal, not greater
    expect(isClaimStale(claim, now)).toBe(false);
  });

  it('should use injectable now parameter', () => {
    const claim = buildClaimContents('/vault');
    claim.timestamp = 1000;
    const eightDaysLater = 1000 + STALE_CLAIM_THRESHOLD_MS + 1;
    expect(isClaimStale(claim, eightDaysLater)).toBe(true);
  });
});

// -------------------------------------------------------------------
// normalisePath
// -------------------------------------------------------------------

describe('normalisePath', () => {
  it('should resolve and normalise a path', () => {
    const result = normalisePath('/a/b/../c');
    expect(result).toContain('/a/c');
  });

  it('should remove trailing slashes', () => {
    const result = normalisePath('/a/b/');
    expect(result).not.toMatch(/\/$/);
  });

  it('should use forward slashes', () => {
    const result = normalisePath('/a/b/c');
    expect(result).not.toContain('\\');
  });
});

// -------------------------------------------------------------------
// checkFolderForCollision
// -------------------------------------------------------------------

describe('checkFolderForCollision', () => {
  let tempDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = path.join(tempDir, 'plugin-data');
    fs.mkdirSync(pluginDir, { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should return null when no claim file exists', () => {
    const result = checkFolderForCollision(tempDir, '/my/vault', Date.now(), pluginDir);
    expect(result).toBeNull();
  });

  it('should return null when claim belongs to same vault', () => {
    writeClaimFile(tempDir, '/my/vault', pluginDir);
    const result = checkFolderForCollision(tempDir, '/my/vault', Date.now(), pluginDir);
    expect(result).toBeNull();
  });

  it('should detect a collision from a different vault', () => {
    writeClaimFile(tempDir, '/other/vault', pluginDir);
    const result = checkFolderForCollision(tempDir, '/my/vault', Date.now(), pluginDir);

    expect(result).not.toBeNull();
    expect(result!.otherVaultPath).toBe('/other/vault');
    expect(result!.thisVaultPath).toBe('/my/vault');
    expect(result!.folderPath).toBe(tempDir);
    expect(result!.isStale).toBe(false);
  });

  it('should mark stale collisions', () => {
    writeClaimFile(tempDir, '/other/vault', pluginDir);

    // Manually age the claim
    const claimPath = getClaimFilePath(pluginDir, tempDir);
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf-8'));
    claim.timestamp = Date.now() - STALE_CLAIM_THRESHOLD_MS - 1000;
    fs.writeFileSync(claimPath, JSON.stringify(claim), 'utf-8');

    const result = checkFolderForCollision(tempDir, '/my/vault', Date.now(), pluginDir);
    expect(result).not.toBeNull();
    expect(result!.isStale).toBe(true);
  });

  it('should work with legacy claims (no pluginDataDir)', () => {
    writeClaimFile(tempDir, '/other/vault');
    const result = checkFolderForCollision(tempDir, '/my/vault');

    expect(result).not.toBeNull();
    expect(result!.otherVaultPath).toBe('/other/vault');
  });
});

// -------------------------------------------------------------------
// checkOutsideVault
// -------------------------------------------------------------------

describe('checkOutsideVault', () => {
  it('should return null when path is inside vault', () => {
    const result = checkOutsideVault(
      '/vault/reMarkable/Sync',
      '/vault',
      'reMarkable/Sync',
    );
    expect(result).toBeNull();
  });

  it('should return null when path equals vault root', () => {
    const result = checkOutsideVault('/vault', '/vault', '.');
    expect(result).toBeNull();
  });

  it('should detect path outside vault', () => {
    const result = checkOutsideVault(
      '/other/place',
      '/vault',
      '../../other/place',
    );
    expect(result).not.toBeNull();
    expect(result!.configuredPath).toBe('../../other/place');
    expect(result!.resolvedPath).toBe('/other/place');
    expect(result!.vaultBasePath).toBe('/vault');
  });

  it('should not match when vault is a prefix of a different path', () => {
    // /vault-extended is NOT inside /vault
    const result = checkOutsideVault(
      '/vault-extended/sub',
      '/vault',
      'sub',
    );
    expect(result).not.toBeNull();
  });
});

// -------------------------------------------------------------------
// collectManagedFolders
// -------------------------------------------------------------------

describe('collectManagedFolders', () => {
  it('should collect unique folders from all sources', () => {
    const folders = collectManagedFolders(
      '/vault',
      ['reMarkable/Sync', 'reMarkable/Sync2'],
      'reMarkable/Highlights',
      'reMarkable/Archive',
    );
    expect(folders).toHaveLength(4);
  });

  it('should deduplicate identical paths', () => {
    const folders = collectManagedFolders(
      '/vault',
      ['reMarkable/Sync'],
      'reMarkable/Sync', // Same as sync folder
      'reMarkable/Archive',
    );
    expect(folders).toHaveLength(2); // Sync + Archive (Sync = Highlights)
  });

  it('should handle absolute paths', () => {
    const folders = collectManagedFolders(
      '/vault',
      ['/absolute/sync'],
      'reMarkable/Highlights',
      'reMarkable/Archive',
    );
    expect(folders).toHaveLength(3);
    expect(folders[0]).toBe('/absolute/sync');
  });
});

// -------------------------------------------------------------------
// writeClaimsAndCheckCollisions (integration)
// -------------------------------------------------------------------

describe('writeClaimsAndCheckCollisions', () => {
  let tempDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = path.join(tempDir, 'plugin-data');
    // Create subfolders
    fs.mkdirSync(path.join(tempDir, 'vault1', 'sync'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'vault1', 'highlights'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'vault1', 'archive'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'vault2'), { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should write claims to plugin data dir, not managed folders', () => {
    const vault1 = path.join(tempDir, 'vault1');
    const syncDir = path.join(vault1, 'sync');
    const hlDir = path.join(vault1, 'highlights');
    const arDir = path.join(vault1, 'archive');

    const result = writeClaimsAndCheckCollisions(
      vault1,
      [syncDir],
      hlDir,
      arDir,
      pluginDir,
    );

    expect(result.collisions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    // Claims should be readable via plugin data dir
    expect(readClaimFile(syncDir, pluginDir)).not.toBeNull();
    expect(readClaimFile(hlDir, pluginDir)).not.toBeNull();
    expect(readClaimFile(arDir, pluginDir)).not.toBeNull();

    // Claims should NOT be in managed folders
    expect(fs.existsSync(path.join(syncDir, CLAIM_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(hlDir, CLAIM_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(arDir, CLAIM_FILENAME))).toBe(false);
  });

  it('should detect collisions from a different vault', () => {
    const vault1 = path.join(tempDir, 'vault1');
    const vault2 = path.join(tempDir, 'vault2');
    const sharedSync = path.join(vault1, 'sync');

    // Vault2 claims the shared folder first (same plugin data dir simulates shared config)
    writeClaimFile(sharedSync, vault2, pluginDir);

    // Vault1 runs its checks
    const result = writeClaimsAndCheckCollisions(
      vault1,
      [sharedSync],
      path.join(vault1, 'highlights'),
      path.join(vault1, 'archive'),
      pluginDir,
    );

    expect(result.collisions).toHaveLength(1);
    expect(normalisePath(result.collisions[0].otherVaultPath)).toBe(
      normalisePath(vault2),
    );
  });

  it('should ignore stale collisions', () => {
    const vault1 = path.join(tempDir, 'vault1');
    const vault2 = path.join(tempDir, 'vault2');
    const sharedSync = path.join(vault1, 'sync');

    // Write a stale claim from vault2
    writeClaimFile(sharedSync, vault2, pluginDir);
    const claimPath = getClaimFilePath(pluginDir, sharedSync);
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf-8'));
    claim.timestamp = Date.now() - STALE_CLAIM_THRESHOLD_MS - 1000;
    fs.writeFileSync(claimPath, JSON.stringify(claim), 'utf-8');

    const result = writeClaimsAndCheckCollisions(
      vault1,
      [sharedSync],
      path.join(vault1, 'highlights'),
      path.join(vault1, 'archive'),
      pluginDir,
    );

    expect(result.collisions).toHaveLength(0);
    expect(result.staleClaimsFound).toBe(1);
  });

  it('should detect outside-vault paths', () => {
    const vault1 = path.join(tempDir, 'vault1');
    const outsideDir = path.join(tempDir, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });

    const result = writeClaimsAndCheckCollisions(
      vault1,
      [outsideDir],
      path.join(vault1, 'highlights'),
      path.join(vault1, 'archive'),
      pluginDir,
    );

    expect(result.outsideVaultWarnings).toHaveLength(1);
    expect(result.outsideVaultWarnings[0].resolvedPath).toBe(outsideDir);
  });
});

// -------------------------------------------------------------------
// removeAllClaims
// -------------------------------------------------------------------

describe('removeAllClaims', () => {
  let tempDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = path.join(tempDir, 'plugin-data');
    fs.mkdirSync(path.join(tempDir, 'sync'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'highlights'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'archive'), { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should remove claim files from plugin data dir', () => {
    const syncDir = path.join(tempDir, 'sync');
    const hlDir = path.join(tempDir, 'highlights');
    const arDir = path.join(tempDir, 'archive');

    // Write claims to plugin data dir
    writeClaimFile(syncDir, tempDir, pluginDir);
    writeClaimFile(hlDir, tempDir, pluginDir);
    writeClaimFile(arDir, tempDir, pluginDir);

    // Verify they exist
    expect(readClaimFile(syncDir, pluginDir)).not.toBeNull();

    // Remove all
    removeAllClaims(tempDir, [syncDir], hlDir, arDir, pluginDir);

    // Verify they are gone
    expect(readClaimFile(syncDir, pluginDir)).toBeNull();
    expect(readClaimFile(hlDir, pluginDir)).toBeNull();
    expect(readClaimFile(arDir, pluginDir)).toBeNull();
  });
});

// -------------------------------------------------------------------
// collisionKey
// -------------------------------------------------------------------

describe('hashFolderPath', () => {
  it('should produce a 16-char hex string', () => {
    const hash = hashFolderPath('/some/path');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should produce consistent hashes for the same path', () => {
    expect(hashFolderPath('/a/b/c')).toBe(hashFolderPath('/a/b/c'));
  });

  it('should produce different hashes for different paths', () => {
    expect(hashFolderPath('/a/b/c')).not.toBe(hashFolderPath('/a/b/d'));
  });
});

describe('collisionKey', () => {
  it('should produce consistent keys for the same collision', () => {
    const collision: Collision = {
      folderPath: '/vault1/sync',
      otherVaultPath: '/vault2',
      thisVaultPath: '/vault1',
      isStale: false,
      otherTimestamp: Date.now(),
    };

    const key1 = collisionKey(collision);
    const key2 = collisionKey(collision);
    expect(key1).toBe(key2);
  });

  it('should produce different keys for different collisions', () => {
    const c1: Collision = {
      folderPath: '/vault1/sync',
      otherVaultPath: '/vault2',
      thisVaultPath: '/vault1',
      isStale: false,
      otherTimestamp: Date.now(),
    };
    const c2: Collision = {
      folderPath: '/vault1/sync',
      otherVaultPath: '/vault3', // Different vault
      thisVaultPath: '/vault1',
      isStale: false,
      otherTimestamp: Date.now(),
    };

    expect(collisionKey(c1)).not.toBe(collisionKey(c2));
  });

  it('should produce different keys for different folders', () => {
    const c1: Collision = {
      folderPath: '/vault1/sync',
      otherVaultPath: '/vault2',
      thisVaultPath: '/vault1',
      isStale: false,
      otherTimestamp: Date.now(),
    };
    const c2: Collision = {
      folderPath: '/vault1/highlights', // Different folder
      otherVaultPath: '/vault2',
      thisVaultPath: '/vault1',
      isStale: false,
      otherTimestamp: Date.now(),
    };

    expect(collisionKey(c1)).not.toBe(collisionKey(c2));
  });

  it('should include :: separator', () => {
    const collision: Collision = {
      folderPath: '/a',
      otherVaultPath: '/b',
      thisVaultPath: '/c',
      isStale: false,
      otherTimestamp: Date.now(),
    };
    expect(collisionKey(collision)).toContain('::');
  });
});
