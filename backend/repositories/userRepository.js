const db = require('../db');
const crypto = require('crypto');

// displayName is optional (organisation owner registration doesn't have
// one) but REQUIRED for PIN login to ever work for this user — pin-login
// looks the user up by display_name (findByDisplayNameScoped), so a user
// created without one can never be found that way, only by email/password.
function createUser({ organisationId, email, passwordHash, passwordSalt, roleId, displayName }) {
  const id = 'user_' + crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO users (id, organisation_id, email, password_hash, password_salt, role_id, status, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, organisationId, email, passwordHash, passwordSalt, roleId, displayName ? displayName.trim() : null, new Date().toISOString());
  return { id, organisationId, email, roleId, displayName: displayName ? displayName.trim() : null };
}

// --- Identity-bridge additions (provision_agents.js) ---------------------
// A roster-provisioned user is an attribution record, not a login: status
// 'provisioned' (not 'active') so it can never pass the active-only check
// in routes/auth.js or middleware/requireAuth.js, even if its random
// password were somehow guessed. It exists only so activities.user_id and
// leads.owner_user_id have something real to point at.

function findByDisplayNameScoped(organisationId, displayName) {
  // Case/whitespace-insensitive match — the join key between a roster name
  // and an existing users.display_name.
  return db.prepare(
    `SELECT * FROM users WHERE organisation_id = ? AND LOWER(TRIM(display_name)) = LOWER(TRIM(?))`
  ).get(organisationId, displayName) || null;
}

function createProvisionedUser({ organisationId, displayName, roleId }) {
  const id = 'user_' + crypto.randomBytes(8).toString('hex');
  // Synthetic, never-shown email — required by the users table's schema
  // and uniqueness constraint, but never used to log in (status blocks that).
  const slug = displayName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'agent';
  const email = `${slug}.${crypto.randomBytes(4).toString('hex')}@roster.${organisationId}.local`;
  const { hash, salt } = require('../auth').hashPassword(crypto.randomBytes(24).toString('hex'));
  db.prepare(
    `INSERT INTO users (id, organisation_id, email, password_hash, password_salt, role_id, status, display_name, provisioned_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'provisioned', ?, 'roster_provisioning', ?)`
  ).run(id, organisationId, email, hash, salt, roleId, displayName.trim(), new Date().toISOString());
  return { id, organisationId, email, roleId, displayName: displayName.trim(), status: 'provisioned' };
}

function findByEmailAnyOrg(email) {
  // Used ONLY at login, before we know which organisation the caller belongs
  // to — email is globally unique enough to look up, but every subsequent
  // request after login is scoped by the session's organisation_id, not by
  // trusting anything the client claims.
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) || null;
}

function findByIdScoped(userId, organisationId) {
  return db.prepare(`SELECT * FROM users WHERE id = ? AND organisation_id = ?`).get(userId, organisationId) || null;
}

function listByOrganisation(organisationId) {
  return db.prepare(`SELECT id, email, role_id, status, display_name, crm_title, created_at FROM users WHERE organisation_id = ?`).all(organisationId);
}

function getPublicByIdScoped(userId, organisationId) {
  return db.prepare(`SELECT id, email, role_id, status, display_name, crm_title, created_at FROM users WHERE id = ? AND organisation_id = ?`).get(userId, organisationId) || null;
}

function updateScoped(id, organisationId, patch) {
  const existing = findByIdScoped(id, organisationId);
  if (!existing) return null;
  const allowed = ['role_id', 'status', 'crm_title'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return getPublicByIdScoped(id, organisationId);
  values.push(id, organisationId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND organisation_id = ?`).run(...values);
  return getPublicByIdScoped(id, organisationId);
}

// --- PIN-agent identity bridge additions ----------------------------------
// setPinScoped: owner/manager-set PIN credential for a roster-provisioned
// (or any) user — same hash/salt shape as a password, stored in the
// pin_hash/pin_salt columns added in db.js. Deliberately a SEPARATE action
// from updateScoped's allow-list (role_id/status) rather than folded in:
// setting a PIN is a distinct, more sensitive action than a role/status
// edit, same reasoning as lead ownership reassignment being its own gate.
function setPinScoped(id, organisationId, { hash, salt }) {
  const existing = findByIdScoped(id, organisationId);
  if (!existing) return null;
  db.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ? AND organisation_id = ?`)
    .run(hash, salt, id, organisationId);
  return getPublicByIdScoped(id, organisationId);
}

// findByDisplayNameScoped already exists below (provisioning bridge) — PIN
// login reuses it verbatim as the lookup key, no new identity concept.

module.exports = {
  createUser, findByEmailAnyOrg, findByIdScoped, listByOrganisation, getPublicByIdScoped,
  updateScoped, findByDisplayNameScoped, createProvisionedUser, setPinScoped
};
