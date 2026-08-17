const db = require('../db');
const crypto = require('crypto');

function record({ organisationId, userId, event, entityType = null, entityId = null, metadata = null }) {
  const id = 'audit_' + crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO audit_events (id, organisation_id, user_id, event, entity_type, entity_id, timestamp, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, organisationId, userId, event, entityType, entityId, new Date().toISOString(), metadata ? JSON.stringify(metadata) : null);
  return id;
}

function listByOrganisation(organisationId) {
  // Scoped — an org can only ever read its own audit trail.
  return db.prepare(`SELECT * FROM audit_events WHERE organisation_id = ? ORDER BY timestamp DESC`).all(organisationId);
}

// No update() or delete() exported on purpose — audit_events is append-only
// from the application's perspective (Phase 2 §M).

module.exports = { record, listByOrganisation };