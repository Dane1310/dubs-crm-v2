const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword, createSession, revokeSession } = require('../auth');
const orgRepo = require('../repositories/organisationRepository');
const userRepo = require('../repositories/userRepository');
const auditRepo = require('../repositories/auditRepository');
const requireAuth = require('../middleware/requireAuth');

// Registers a brand-new organisation AND its first user (as OWNER) in one
// atomic step. There's no platform-admin concept yet (Phase 2 explicitly
// scoped that out) — this is the minimum bootstrap path so an organisation
// can exist at all without a chicken-and-egg auth problem.
router.post('/organisations/register', (req, res) => {
  const { organisationName, ownerEmail, ownerPassword } = req.body || {};
  if (!organisationName || !ownerEmail || !ownerPassword) {
    return res.status(400).json({ error: 'organisationName, ownerEmail and ownerPassword are all required' });
  }
  if (typeof ownerPassword !== 'string' || ownerPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (userRepo.findByEmailAnyOrg(ownerEmail)) {
    return res.status(409).json({ error: 'That email is already registered' });
  }

  const org = orgRepo.createOrganisation(organisationName);
  const { hash, salt } = hashPassword(ownerPassword);
  const ownerRoleId = 'role_default_owner';
  const user = userRepo.createUser({
    organisationId: org.id, email: ownerEmail, passwordHash: hash, passwordSalt: salt, roleId: ownerRoleId
  });
  auditRepo.record({ organisationId: org.id, userId: user.id, event: 'organisation.created', entityType: 'organisation', entityId: org.id });
  auditRepo.record({ organisationId: org.id, userId: user.id, event: 'user.created', entityType: 'user', entityId: user.id, metadata: { role: 'OWNER' } });

  res.status(201).json({ organisation: org, user: { id: user.id, email: ownerEmail, role: 'OWNER' } });
});

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = userRepo.findByEmailAnyOrg(email);
  // Deliberately identical error for "no such user" and "wrong password" —
  // don't leak which one it was.
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'Account is not active' });

  const session = createSession(user.id, user.organisation_id);
  auditRepo.record({ organisationId: user.organisation_id, userId: user.id, event: 'login' });
  res.json({ token: session.token, expiresAt: session.expiresAt });
});

// PIN LOGIN — the floor-agent identity bridge. A roster-provisioned user
// (status 'provisioned', created by provision_agents.js, no email/password
// login possible — see routes/protected.js PUT /users/:id/pin for how the
// PIN gets set) authenticates with {organisationId, displayName, pin}
// instead. Deliberately org-scoped by an explicit organisationId in the
// body — unlike email (checked globally, then scoped by session), a PIN is
// short and a display name is not remotely unique across organisations,
// so both are required to find the right row at all.
//
// On first successful PIN login, a still-'provisioned' user is flipped to
// 'active' — this is what "activation" means here: proving you know the
// PIN an owner assigned you. requireAuth's existing `status === 'active'`
// check is untouched; this only ever produces a session for a user that
// check already accepts, so no other route needed to change.
router.post('/auth/pin-login', (req, res) => {
  const { organisationId, displayName, pin } = req.body || {};
  if (!organisationId || !displayName || !pin) {
    return res.status(400).json({ error: 'organisationId, displayName and pin are all required' });
  }
  const user = userRepo.findByDisplayNameScoped(organisationId, displayName);
  // Identical error whether the name doesn't exist, has no PIN set yet, or
  // the PIN is wrong — same "don't leak which" reasoning as email/password.
  const genericError = () => res.status(401).json({ error: 'Invalid name or PIN' });
  if (!user || user.status === 'disabled') return genericError();
  if (!user.pin_hash || !user.pin_salt) return genericError();
  if (!verifyPassword(pin, user.pin_salt, user.pin_hash)) return genericError();

  if (user.status === 'provisioned') {
    userRepo.updateScoped(user.id, organisationId, { status: 'active' });
    auditRepo.record({ organisationId, userId: user.id, event: 'user.activated_via_pin', entityType: 'user', entityId: user.id });
  }

  const session = createSession(user.id, organisationId);
  auditRepo.record({ organisationId, userId: user.id, event: 'pin_login' });
  const role = db.prepare(`SELECT name FROM roles WHERE id = ?`).get(user.role_id);
  res.json({
    token: session.token, expiresAt: session.expiresAt,
    user: { id: user.id, displayName: user.display_name, role: role ? role.name : user.role_id },
  });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  revokeSession(req.sessionToken);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'logout' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const role = db.prepare(`SELECT name FROM roles WHERE id = ?`).get(req.user.role_id);
  res.json({
    id: req.user.id,
    email: req.user.email,
    organisationId: req.user.organisation_id,
    role: role ? role.name : req.user.role_id,
  });
});

module.exports = router;