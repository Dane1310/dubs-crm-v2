const db = require('../db');
const crypto = require('crypto');

function createActivity(data) {
  const id = 'activity_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO activities (
      id, organisation_id, lead_id, contact_id, user_id, channel, direction,
      outcome, notes, duration_seconds, external_ref, follow_up_id,
      occurred_at, created_at, updated_at, reason, sentiment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.organisationId, data.leadId || null, data.contactId || null, data.userId,
    data.channel, data.direction || null, data.outcome || null, data.notes || null,
    data.durationSeconds || null, data.externalRef || null, data.followUpId || null,
    data.occurredAt || now, now, now, data.reason || null, data.sentiment || null
  );
  return getByIdScoped(id, data.organisationId);
}

function getByIdScoped(id, organisationId) {
  return db.prepare(`SELECT * FROM activities WHERE id = ? AND organisation_id = ?`).get(id, organisationId) || null;
}

function listScoped(organisationId, { userId = null, leadId = null, contactId = null } = {}) {
  let sql = `SELECT * FROM activities WHERE organisation_id = ?`;
  const params = [organisationId];
  if (userId) { sql += ` AND user_id = ?`; params.push(userId); }
  if (leadId) { sql += ` AND lead_id = ?`; params.push(leadId); }
  // contactId added (Phase 9 gap-closure) — same pattern as leadId, needed
  // for GET /contacts/:id/activities, the read side of activity.create
  // when an activity is logged directly against a contact rather than a lead.
  if (contactId) { sql += ` AND contact_id = ?`; params.push(contactId); }
  sql += ` ORDER BY occurred_at DESC`;
  return db.prepare(sql).all(...params);
}

function updateScoped(id, organisationId, patch) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  const allowed = ['channel','direction','outcome','notes','duration_seconds','reason','sentiment'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id, organisationId); // scoped WHERE — org_id re-applied regardless of what patch contains
  db.prepare(`UPDATE activities SET ${sets.join(', ')} WHERE id = ? AND organisation_id = ?`).run(...values);
  return getByIdScoped(id, organisationId);
}

module.exports = { createActivity, getByIdScoped, listScoped, updateScoped };