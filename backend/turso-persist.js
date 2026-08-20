// turso-persist.js — OPTIONAL persistence bridge for Render's ephemeral
// filesystem. This file does NOT touch db.js, any repository, or any
// route. It treats the entire local SQLite file as an opaque blob and
// ships it to/from Turso — it never talks SQL against the app's own
// tables, and Turso is used here purely as a durable place to park that
// blob, not as the query engine the app runs against day to day.
//
// Why a whole-file snapshot instead of pointing db.js at Turso directly:
// db.js already works, is already tested, and every repository already
// depends on node:sqlite's synchronous API. Rewriting that to libsql's
// async client would touch ~1,800 lines across every repository and
// route — exactly the "replace the working backend" risk this was
// explicitly built to avoid. This is strictly additive: remove this file
// and two lines in server.js, and the backend behaves exactly as it does
// today.
//
// Boot sequence this enables:
//   1. restoreFromTurso() — if a local DB file already exists, do
//      nothing (never overwrite a live file). If one doesn't exist
//      (true on every fresh Render restart today) and Turso has a
//      saved snapshot, write those bytes to disk BEFORE db.js opens
//      the file.
//   2. server.js then requires db.js as normal — db.js has no idea
//      any of this happened.
//   3. startPeriodicSave() — every 60s, and on SIGTERM/SIGINT (the
//      signal Render sends before stopping/restarting a service —
//      the actual moment data would otherwise be lost), push the
//      current file bytes back up to Turso.
//
// If TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are unset, every function
// here is a documented no-op and the server boots exactly as it does
// today, unchanged.

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.FOUNDATION_DB_PATH || path.join(__dirname, 'foundation.db');
const SAVE_INTERVAL_MS = 60 * 1000;

// Read fresh on every call, not captured as a module-load-time constant —
// a prior version of this pattern had a real bug where env vars read once
// at require-time could miss a value set later in an unusual startup
// order. Fixed here from the start.
function tursoUrl() { return process.env.TURSO_DATABASE_URL || ''; }
function tursoToken() { return process.env.TURSO_AUTH_TOKEN || ''; }
function isConfigured() { return !!(tursoUrl() && tursoToken()); }

let _client = null;
function getClient() {
  if (!isConfigured()) return null;
  if (!_client) {
    // Lazy require: if Turso isn't configured, @libsql/client is never
    // touched at all — one less thing that can fail on a deploy that
    // doesn't use this feature.
    const { createClient } = require('@libsql/client');
    _client = createClient({ url: tursoUrl(), authToken: tursoToken() });
  }
  return _client;
}

// Allows tests to inject a fake client instead of a real network-backed
// one — see turso-persist.test.js.
function _setClientForTesting(fakeClient) { _client = fakeClient; }
function _resetClientForTesting() { _client = null; }

async function ensureSnapshotTable(client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS __foundation_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      saved_at TEXT NOT NULL
    )
  `);
}

async function restoreFromTurso() {
  if (!isConfigured()) {
    console.log('[turso-persist] TURSO_DATABASE_URL/TURSO_AUTH_TOKEN not set — skipping restore, local file behaves exactly as before.');
    return { restored: false, reason: 'not-configured' };
  }
  if (fs.existsSync(DB_PATH)) {
    console.log('[turso-persist] Local DB file already exists at', DB_PATH, '— skipping restore. Never overwrite a live local file with an older snapshot.');
    return { restored: false, reason: 'local-file-exists' };
  }
  try {
    const client = getClient();
    await ensureSnapshotTable(client);
    const result = await client.execute('SELECT data, byte_length, saved_at FROM __foundation_snapshot WHERE id = 1');
    if (!result.rows || result.rows.length === 0) {
      console.log('[turso-persist] No snapshot in Turso yet — starting fresh (expected on the very first boot ever).');
      return { restored: false, reason: 'no-snapshot' };
    }
    const row = result.rows[0];
    const buffer = Buffer.from(row.data);
    if (buffer.length !== row.byte_length) {
      // Corrupt/partial snapshot — refuse to restore garbage over a
      // legitimately-empty fresh start. Boot empty rather than boot broken.
      console.error(`[turso-persist] Snapshot length mismatch (expected ${row.byte_length}, got ${buffer.length}) — refusing to restore. Booting with a fresh empty database instead.`);
      return { restored: false, reason: 'length-mismatch' };
    }
    fs.writeFileSync(DB_PATH, buffer);
    console.log(`[turso-persist] Restored ${buffer.length} bytes from Turso snapshot saved at ${row.saved_at}.`);
    return { restored: true, bytes: buffer.length, savedAt: row.saved_at };
  } catch (err) {
    console.error('[turso-persist] Restore failed — booting with a fresh empty local database rather than crashing:', err.message);
    return { restored: false, reason: 'error', error: err.message };
  }
}

async function saveToTurso() {
  if (!isConfigured()) return { saved: false, reason: 'not-configured' };
  if (!fs.existsSync(DB_PATH)) return { saved: false, reason: 'no-local-file' };
  try {
    const client = getClient();
    await ensureSnapshotTable(client);
    const buffer = fs.readFileSync(DB_PATH);
    await client.execute({
      sql: `INSERT INTO __foundation_snapshot (id, data, byte_length, saved_at) VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, byte_length = excluded.byte_length, saved_at = excluded.saved_at`,
      args: [buffer, buffer.length, new Date().toISOString()],
    });
    return { saved: true, bytes: buffer.length };
  } catch (err) {
    console.error('[turso-persist] Save failed — server keeps running normally, will retry on the next interval:', err.message);
    return { saved: false, reason: 'error', error: err.message };
  }
}

let _intervalHandle = null;
function startPeriodicSave() {
  if (!isConfigured()) return;
  if (_intervalHandle) return; // idempotent — calling twice doesn't double the timer
  _intervalHandle = setInterval(() => {
    saveToTurso().then((r) => {
      if (r.saved) console.log(`[turso-persist] Periodic save: ${r.bytes} bytes.`);
    });
  }, SAVE_INTERVAL_MS);
  _intervalHandle.unref(); // don't keep the process alive just for this timer
}

function stopPeriodicSave() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

// Best-effort save on the signals Render actually sends before stopping
// or restarting a service — this is the real moment data would otherwise
// be lost. "Best-effort" because a process can still be killed harder
// than this if it doesn't exit in time; the 60s periodic save is the
// backstop for that case.
let _shutdownRegistered = false;
function registerShutdownSave() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  const handler = async (signal) => {
    console.log(`[turso-persist] Received ${signal} — saving final snapshot to Turso before exit.`);
    await saveToTurso();
    process.exit(0);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

module.exports = {
  restoreFromTurso,
  saveToTurso,
  startPeriodicSave,
  stopPeriodicSave,
  registerShutdownSave,
  isConfigured,
  DB_PATH,
  _setClientForTesting,
  _resetClientForTesting,
};
