const db = require('../db');
const crypto = require('crypto');

function createContact({ organisationId, name, email, phone }) {
  const id = 'contact_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, organisation_id, name, email, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, organisationId, name || null, email || null, phone || null, now, now);
  return { id, organisationId, name, email, phone };
}

function getByIdScoped(id, organisationId) {
  return db.prepare(`SELECT * FROM contacts WHERE id = ? AND organisation_id = ?`).get(id, organisationId) || null;
}

function listByOrganisation(organisationId) {
  return db.prepare(`SELECT * FROM contacts WHERE organisation_id = ?`).all(organisationId);
}

function updateScoped(id, organisationId, patch) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  const allowed = ['name', 'email', 'phone'];
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
  values.push(id, organisationId); // organisation_id repeated in WHERE on purpose — same isolation pattern as leadRepository.
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ? AND organisation_id = ?`).run(...values);
  return getByIdScoped(id, organisationId);
}

module.exports = { createContact, getByIdScoped, listByOrganisation, updateScoped };