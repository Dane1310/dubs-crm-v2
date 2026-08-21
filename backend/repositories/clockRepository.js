const db = require('../db');
const crypto = require('crypto');

// One open session (clock_out_at IS NULL) per user at a time is the whole
// invariant this repository enforces — routes/clock.js relies on
// getOpenSessionScoped() to decide whether an incoming request is a clock-in
// or a clock-out, so every write here goes through that same read first.

function getOpenSessionScoped(organisationId, userId) {
  return db.prepare(
    `SELECT * FROM clock_sessions WHERE organisation_id = ? AND user_id = ? AND clock_out_at IS NULL`
  ).get(organisationId, userId) || null;
}

function clockIn(organisationId, userId) {
  const id = 'clock_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO clock_sessions (id, organisation_id, user_id, clock_in_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, organisationId, userId, now, now);
  return getByIdScoped(id, organisationId);
}

function clockOut(organisationId, userId) {
  const open = getOpenSessionScoped(organisationId, userId);
  if (!open) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE clock_sessions SET clock_out_at = ? WHERE id = ? AND organisation_id = ?`
  ).run(now, open.id, organisationId);
  return getByIdScoped(open.id, organisationId);
}

function getByIdScoped(id, organisationId) {
  return db.prepare(`SELECT * FROM clock_sessions WHERE id = ? AND organisation_id = ?`).get(id, organisationId) || null;
}

// Own history — newest first, optionally bounded by an ISO date range.
// `from`/`to` compare against clock_in_at as plain ISO-8601 strings, which
// sort correctly lexicographically (same convention used elsewhere in this
// codebase, e.g. stageHistoryRepository).
function listForUserScoped(organisationId, userId, { from = null, to = null } = {}) {
  const clauses = ['organisation_id = ?', 'user_id = ?'];
  const params = [organisationId, userId];
  if (from) { clauses.push('clock_in_at >= ?'); params.push(from); }
  if (to)   { clauses.push('clock_in_at <= ?'); params.push(to); }
  return db.prepare(
    `SELECT * FROM clock_sessions WHERE ${clauses.join(' AND ')} ORDER BY clock_in_at DESC`
  ).all(...params);
}

// Org-wide — for Owner/Manager reporting (gated by data.view.org in the
// route, same convention as GET /tasks and GET /leads).
function listForOrganisation(organisationId, { from = null, to = null } = {}) {
  const clauses = ['organisation_id = ?'];
  const params = [organisationId];
  if (from) { clauses.push('clock_in_at >= ?'); params.push(from); }
  if (to)   { clauses.push('clock_in_at <= ?'); params.push(to); }
  return db.prepare(
    `SELECT * FROM clock_sessions WHERE ${clauses.join(' AND ')} ORDER BY clock_in_at DESC`
  ).all(...params);
}

module.exports = { getOpenSessionScoped, clockIn, clockOut, getByIdScoped, listForUserScoped, listForOrganisation };
