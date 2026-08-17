const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission, DEFAULT_ROLES } = require('../permissions');
const orgRepo = require('../repositories/organisationRepository');
const userRepo = require('../repositories/userRepository');
const auditRepo = require('../repositories/auditRepository');
const { hashPassword } = require('../auth');

router.use(requireAuth); // everything below requires a valid session

// Organisation-scoped read. Note: the org id to fetch comes from the URL
// (what the client ASKS for), but the repository only returns it if it
// matches req.user.organisation_id (what the SERVER knows to be true from
// the session). This is the concrete test for Phase 2 §C / litmus test #7.
router.get('/organisations/:id', (req, res) => {
  const org = orgRepo.getOrganisationById(req.params.id, req.user.organisation_id);
  if (!org) return res.status(403).json({ error: 'Forbidden — not your organisation, or it does not exist' });
  res.json(org);
});

router.get('/users', requirePermission('users.manage'), (req, res) => {
  res.json(userRepo.listByOrganisation(req.user.organisation_id));
});

// CREATE user — adds a new user (agent/senior/manager/owner) to the
// CALLER'S organisation. organisation_id always from the session, never
// from the request body — same isolation pattern as every other create.
router.post('/users', requirePermission('users.manage'), (req, res) => {
  const { email, password, role, displayName } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const roleName = (role || 'AGENT').toString().toUpperCase();
  if (!DEFAULT_ROLES[roleName]) {
    return res.status(400).json({ error: `role must be one of: ${Object.keys(DEFAULT_ROLES).join(', ')}` });
  }
  if (userRepo.findByEmailAnyOrg(email)) {
    return res.status(409).json({ error: 'That email is already registered' });
  }
  if (displayName && userRepo.findByDisplayNameScoped(req.user.organisation_id, displayName)) {
    return res.status(409).json({ error: 'That display name is already in use in your organisation' });
  }
  const { hash, salt } = hashPassword(password);
  const roleId = 'role_default_' + roleName.toLowerCase();
  const user = userRepo.createUser({
    organisationId: req.user.organisation_id, email, passwordHash: hash, passwordSalt: salt, roleId, displayName
  });
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'user.created', entityType: 'user', entityId: user.id, metadata: { role: roleName } });
  res.status(201).json(userRepo.getPublicByIdScoped(user.id, req.user.organisation_id));
});

// UPDATE user — role change and/or activate/deactivate. A deactivated
// user is blocked at the very next request: requireAuth re-checks
// user.status on every call, so this takes effect immediately, not just
// on next login.
router.put('/users/:id', requirePermission('users.manage'), (req, res) => {
  const existing = userRepo.findByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const patch = {};
  if (req.body.role !== undefined) {
    const roleName = req.body.role.toString().toUpperCase();
    if (!DEFAULT_ROLES[roleName]) {
      return res.status(400).json({ error: `role must be one of: ${Object.keys(DEFAULT_ROLES).join(', ')}` });
    }
    patch.role_id = 'role_default_' + roleName.toLowerCase();
  }
  if (req.body.status !== undefined) {
    if (!['active', 'disabled'].includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: active, disabled` });
    }
    patch.status = req.body.status;
  }
  const updated = userRepo.updateScoped(req.params.id, req.user.organisation_id, patch);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'user.updated', entityType: 'user', entityId: req.params.id, metadata: patch });
  res.json(updated);
});

// SET PIN — owner/manager assigns or changes a user's PIN, the same
// permission tier as any other user edit above. This is what gives a
// roster-provisioned identity (status 'provisioned', no password login —
// see provision_agents.js) something it can actually authenticate with,
// via POST /auth/pin-login. Mirrors the existing frontend product pattern
// (an owner assigns/approves each agent's PIN) rather than a self-service
// claim, so nobody can squat an unclaimed name.
router.put('/users/:id/pin', requirePermission('users.manage'), (req, res) => {
  const existing = userRepo.findByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string' || pin.trim().length < 4) {
    return res.status(400).json({ error: 'pin is required and must be at least 4 characters' });
  }
  const { hash, salt } = hashPassword(pin.trim());
  const updated = userRepo.setPinScoped(req.params.id, req.user.organisation_id, { hash, salt });
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'user.pin_set', entityType: 'user', entityId: req.params.id });
  res.json(updated);
});

router.get('/audit', requirePermission('audit.view'), (req, res) => {
  res.json(auditRepo.listByOrganisation(req.user.organisation_id));
});

// Stand-in for "restricted owner functions" — exists purely so the
// permission system and litmus test #9 have something concrete to check
// against. Real owner-only operations (config changes, backups, etc.)
// plug into this same requirePermission('owner.restricted') pattern later.
router.post('/owner/restricted-action', requirePermission('owner.restricted'), (req, res) => {
  auditRepo.record({
    organisationId: req.user.organisation_id, userId: req.user.id,
    event: 'owner.restricted_action_performed'
  });
  res.json({ ok: true, message: 'Restricted action performed' });
});

module.exports = router;