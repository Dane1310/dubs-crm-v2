// auth.js — password hashing (scrypt, built into Node, no external dependency)
// and session token issuance/validation. No JWT library used deliberately —
// opaque random tokens looked up server-side are simpler to revoke correctly
// (logout = delete the row) and simpler to reason about for this scale.

const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(plainPassword, salt, expectedHash) {
  const hash = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  // timing-safe compare — avoid leaking hash correctness via response time
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createSession(userId, organisationId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    `INSERT INTO sessions (token, user_id, organisation_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(token, userId, organisationId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

function getSession(token) {
  const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

function revokeSession(token) {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE token = ?`).run(new Date().toISOString(), token);
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, revokeSession };