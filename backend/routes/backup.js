const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission } = require('../permissions');
const userRepo = require('../repositories/userRepository');
const leadRepo = require('../repositories/leadRepository');
const contactRepo = require('../repositories/contactRepository');
const activityRepo = require('../repositories/activityRepository');
const taskRepo = require('../repositories/taskRepository');
const auditRepo = require('../repositories/auditRepository');
const orgRepo = require('../repositories/organisationRepository');
const auditRepoAgain = auditRepo; // (kept as one import, name is only for readability below)

// This did NOT exist anywhere in the backend before now — the frontend's
// "Download full backup" button only ever wrote window.storage data to a
// file; it never called this API, because this route didn't exist. This
// is the first version, gated the same way every other owner-only route is
// (requirePermission('owner.restricted') — only the OWNER role holds it).
//
// Sensitive fields are deliberately stripped: password_hash, password_salt,
// pin_hash, pin_salt never leave this endpoint, even for the owner. A
// backup restore path (not built yet) would need to force a password/PIN
// reset for every user rather than round-tripping credentials.
router.get('/backup', requireAuth, requirePermission('owner.restricted'), (req, res) => {
  const orgId = req.user.organisation_id;

  const org = orgRepo.getOrganisationById(orgId, orgId);
  const users = userRepo.listByOrganisation(orgId).map(u => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name || null,
    roleId: u.role_id,
    status: u.status,
    createdAt: u.created_at,
    // password_hash / password_salt / pin_hash / pin_salt intentionally omitted.
  }));
  const leads = leadRepo.listScoped(orgId, { includeArchived: true });
  const contacts = contactRepo.listByOrganisation(orgId);
  const activities = activityRepo.listScoped(orgId);
  const tasks = taskRepo.listScoped(orgId);
  const audit = auditRepoAgain.listByOrganisation(orgId);

  res.json({
    generatedAt: new Date().toISOString(),
    organisation: org,
    users,
    leads,
    contacts,
    activities,
    tasks,
    auditEvents: audit,
  });
});

module.exports = router;
