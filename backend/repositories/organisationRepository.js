// organisationRepository.js
// Every method that returns organisation-owned data REQUIRES an
// organisationId argument and filters by it in the SQL itself.
// There is deliberately no "get all" method that skips this — the
// repository layer is the structural enforcement point from Phase 2 §C,
// not just a convenience wrapper.

const db = require('../db');
const crypto = require('crypto');

function createOrganisation(name) {
  const id = 'org_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`INSERT INTO organisations (id, name, created_at) VALUES (?, ?, ?)`)
    .run(id, name, new Date().toISOString());
  return { id, name };
}

function getOrganisationById(organisationId, requestingOrgId) {
  // requestingOrgId must match — this repository will not return another
  // organisation's row even if directly asked for its ID.
  if (organisationId !== requestingOrgId) return null;
  return db.prepare(`SELECT * FROM organisations WHERE id = ?`).get(organisationId) || null;
}

module.exports = { createOrganisation, getOrganisationById };