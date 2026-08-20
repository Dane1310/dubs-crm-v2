// test_turso_persist.js — exercises turso-persist.js against a FAKE
// libsql client (in-memory, no real network). This sandbox has no route
// to turso.io, so this cannot prove the real network call works — only
// that the logic around it (restore-before-boot, never-overwrite-local,
// fail-safe-on-error, round-trip byte accuracy, the actual wipe-and-
// restore scenario this exists to fix) is correct. The real network path
// can only be proven on an actual Render deploy — see
// PHASE_TURSO_DEPLOYMENT.md for exactly how to verify that.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEST_DB_PATH = path.join(__dirname, 'test_turso_persist.db');
process.env.FOUNDATION_DB_PATH = TEST_DB_PATH;
process.env.TURSO_DATABASE_URL = 'libsql://fake-test-db.turso.io';
process.env.TURSO_AUTH_TOKEN = 'fake-test-token';

const persist = require('./turso-persist');

// ---- Fake libsql client: an in-memory stand-in for what @libsql/client
// would actually do. Implements just the one method (.execute) this file
// uses, faithfully enough (params binding, ON CONFLICT upsert) to catch
// real logic bugs on our side.
function makeFakeClient({ failRestore = false, failSave = false } = {}) {
  let row = null; // { data: Buffer, byte_length, saved_at }
  return {
    _row: () => row,
    async execute(query) {
      const sql = typeof query === 'string' ? query : query.sql;
      const args = typeof query === 'string' ? [] : (query.args || []);
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/SELECT data/i.test(sql)) {
        if (failRestore) throw new Error('simulated network failure on restore');
        return { rows: row ? [row] : [] };
      }
      if (/INSERT INTO __foundation_snapshot/i.test(sql)) {
        if (failSave) throw new Error('simulated network failure on save');
        const [data, byte_length, saved_at] = args;
        row = { data, byte_length, saved_at };
        return { rows: [] };
      }
      throw new Error('unexpected query in fake client: ' + sql);
    },
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok —', name);
  } catch (err) {
    failed++;
    console.log('FAIL —', name, '\n   ', err.message);
  }
}

function cleanupDbFile() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
}

(async () => {
  // --- Scenario 1: not configured at all -> everything is a safe no-op
  await test('not configured: restore is a no-op, never touches fs', async () => {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    persist._resetClientForTesting();
    cleanupDbFile();
    const result = await persist.restoreFromTurso();
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.reason, 'not-configured');
    assert.strictEqual(fs.existsSync(TEST_DB_PATH), false);
    process.env.TURSO_DATABASE_URL = 'libsql://fake-test-db.turso.io';
    process.env.TURSO_AUTH_TOKEN = 'fake-test-token';
  });

  // --- Scenario 2: configured, no local file, no snapshot yet -> boots empty, no crash
  await test('configured, first ever boot: no snapshot exists, boots empty without crashing', async () => {
    cleanupDbFile();
    const fake = makeFakeClient();
    persist._setClientForTesting(fake);
    const result = await persist.restoreFromTurso();
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.reason, 'no-snapshot');
    assert.strictEqual(fs.existsSync(TEST_DB_PATH), false);
  });

  // --- Scenario 3: THE ACTUAL BUG THIS FIXES — save, wipe local file
  // (simulating a Render restart), then restore, confirm byte-for-byte match
  await test('the real bug: save -> wipe local file -> restore -> byte-for-byte identical', async () => {
    cleanupDbFile();
    const fake = makeFakeClient();
    persist._setClientForTesting(fake);

    const originalBytes = Buffer.from('SQLITE FORMAT 3\0-- this stands in for real database bytes --' + 'x'.repeat(500));
    fs.writeFileSync(TEST_DB_PATH, originalBytes);

    const saveResult = await persist.saveToTurso();
    assert.strictEqual(saveResult.saved, true);
    assert.strictEqual(saveResult.bytes, originalBytes.length);

    // Simulate exactly what Render's free tier does on every restart:
    // the local file is gone.
    fs.unlinkSync(TEST_DB_PATH);
    assert.strictEqual(fs.existsSync(TEST_DB_PATH), false);

    const restoreResult = await persist.restoreFromTurso();
    assert.strictEqual(restoreResult.restored, true);
    assert.strictEqual(restoreResult.bytes, originalBytes.length);

    const restoredBytes = fs.readFileSync(TEST_DB_PATH);
    assert.ok(restoredBytes.equals(originalBytes), 'restored bytes must exactly match what was saved');
  });

  // --- Scenario 4: never overwrite a live local file
  await test('local file already exists: restore refuses to touch it', async () => {
    cleanupDbFile();
    const fake = makeFakeClient();
    persist._setClientForTesting(fake);

    const oldSnapshot = Buffer.from('old snapshot bytes from a previous save');
    await fs.promises.writeFile(TEST_DB_PATH + '.tmp', oldSnapshot);
    fs.renameSync(TEST_DB_PATH + '.tmp', TEST_DB_PATH);
    // seed a snapshot in the fake Turso so we can prove it's genuinely skipped, not just absent
    await persist.saveToTurso();

    const liveBytes = Buffer.from('THIS IS THE LIVE LOCAL FILE — MUST NOT BE OVERWRITTEN');
    fs.writeFileSync(TEST_DB_PATH, liveBytes);

    const result = await persist.restoreFromTurso();
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.reason, 'local-file-exists');
    const stillLive = fs.readFileSync(TEST_DB_PATH);
    assert.ok(stillLive.equals(liveBytes), 'local file must be untouched');
  });

  // --- Scenario 5: network error on restore -> fails safe, doesn't crash
  await test('network error on restore: fails safe, does not throw, does not crash the boot', async () => {
    cleanupDbFile();
    const fake = makeFakeClient({ failRestore: true });
    persist._setClientForTesting(fake);
    const result = await persist.restoreFromTurso();
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.reason, 'error');
    assert.strictEqual(fs.existsSync(TEST_DB_PATH), false);
  });

  // --- Scenario 6: network error on save -> fails safe, server keeps running
  await test('network error on save: fails safe, does not throw', async () => {
    cleanupDbFile();
    fs.writeFileSync(TEST_DB_PATH, Buffer.from('some data'));
    const fake = makeFakeClient({ failSave: true });
    persist._setClientForTesting(fake);
    const result = await persist.saveToTurso();
    assert.strictEqual(result.saved, false);
    assert.strictEqual(result.reason, 'error');
  });

  // --- Scenario 7: corrupt/partial snapshot -> refuses to restore garbage
  await test('corrupt snapshot (length mismatch): refuses to restore, boots empty instead', async () => {
    cleanupDbFile();
    const fake = makeFakeClient();
    persist._setClientForTesting(fake);
    // Manually inject a snapshot row with a byte_length that doesn't match the data
    await fake.execute({
      sql: `INSERT INTO __foundation_snapshot (id, data, byte_length, saved_at) VALUES (1, ?, ?, ?)`,
      args: [Buffer.from('short'), 99999, new Date().toISOString()],
    });
    const result = await persist.restoreFromTurso();
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.reason, 'length-mismatch');
    assert.strictEqual(fs.existsSync(TEST_DB_PATH), false);
  });

  // --- Scenario 8: isConfigured() reflects env vars correctly
  await test('isConfigured() is true only when both env vars are set', async () => {
    delete process.env.TURSO_DATABASE_URL;
    assert.strictEqual(persist.isConfigured(), false);
    process.env.TURSO_DATABASE_URL = 'libsql://fake-test-db.turso.io';
    assert.strictEqual(persist.isConfigured(), true);
    delete process.env.TURSO_AUTH_TOKEN;
    assert.strictEqual(persist.isConfigured(), false);
    process.env.TURSO_AUTH_TOKEN = 'fake-test-token';
    assert.strictEqual(persist.isConfigured(), true);
  });

  cleanupDbFile();
  persist._resetClientForTesting();
  persist.stopPeriodicSave();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
